import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useOutletContext } from 'react-router-dom'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import {
  getGraph,
  getLabelsets,
  getRelationsGraph,
  type RelationsGraph,
  searchTenantFull,
} from '../api/client.ts'
import { EmptyState, ErrorCard, Skeleton } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// The knowledge map: a live, explorable graph of how the corpus connects.
// Two lenses share one canvas engine - the entity graph (relations the
// knowledge-graph agent extracted) and the concept map (how taxonomy
// categories co-occur). The canvas runs a real force simulation with drag,
// wheel zoom and pan; selecting a node opens an evidence panel and a path
// mode answers "how are these two things connected?".
// ---------------------------------------------------------------------------

const WIDTH = 960
const HEIGHT = 640

type Mode = 'entity' | 'concept'

type MapNode = {
  id: string
  label: string
  group: string
  weight: number
}

type MapEdge = {
  source: string
  target: string
  label: string
  weight: number
}

type SimNode = MapNode & {
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
  index?: number
}

type Transform = { x: number; y: number; k: number }

/** Canvas label - long programme titles get an ellipsis; panels show the full name. */
function shortLabel(label: string): string {
  return label.length > 38 ? `${label.slice(0, 36)}…` : label
}

function radiusFor(weight: number): number {
  return Math.max(7, Math.min(26, Math.sqrt(weight) * 3.4 + 6))
}

const CATEGORY_COLOURS = [
  'var(--rp-cat-1)',
  'var(--rp-cat-2)',
  'var(--rp-cat-3)',
  'var(--rp-cat-4)',
  'var(--rp-cat-5)',
  'var(--rp-cat-6)',
]

/** Stable colour per group name - assigned in first-seen order for contrast. */
function buildGroupColours(nodes: MapNode[]): Map<string, string> {
  const colours = new Map<string, string>()
  for (const node of nodes) {
    if (!colours.has(node.group)) {
      colours.set(
        node.group,
        CATEGORY_COLOURS[colours.size % CATEGORY_COLOURS.length] ?? 'var(--rp-cat-1)',
      )
    }
  }
  return colours
}

// ---------------------------------------------------------------------------
// Path finding - breadth-first over the loaded edges (undirected), so "how
// are these two connected?" answers instantly from what is on screen.
// ---------------------------------------------------------------------------

function shortestPath(edges: MapEdge[], from: string, to: string): MapEdge[] | null {
  if (from === to) return []
  const adjacency = new Map<string, MapEdge[]>()
  for (const edge of edges) {
    for (const end of [edge.source, edge.target]) {
      const list = adjacency.get(end)
      if (list) list.push(edge)
      else adjacency.set(end, [edge])
    }
  }
  const cameFrom = new Map<string, MapEdge>()
  const queue = [from]
  const seen = new Set([from])
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const edge of adjacency.get(current) ?? []) {
      const next = edge.source === current ? edge.target : edge.source
      if (seen.has(next)) continue
      seen.add(next)
      cameFrom.set(next, edge)
      if (next === to) {
        const path: MapEdge[] = []
        let cursor = to
        while (cursor !== from) {
          const step = cameFrom.get(cursor) as MapEdge
          path.unshift(step)
          cursor = step.source === cursor ? step.target : step.source
        }
        return path
      }
      queue.push(next)
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Live force simulation - positions live in a ref, a rAF loop repaints while
// the simulation is warm or a node is being dragged. React renders the
// structure; the loop only nudges coordinates.
// ---------------------------------------------------------------------------

function useLiveSimulation(nodes: MapNode[], edges: MapEdge[]) {
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null)
  const nodesRef = useRef<SimNode[]>([])
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const simNodes: SimNode[] = nodes.map((n) => {
      // Keep the position of nodes that survive a data change (expand).
      const existing = nodesRef.current.find((p) => p.id === n.id)
      return { ...n, x: existing?.x, y: existing?.y }
    })
    nodesRef.current = simNodes
    const simEdges = edges.map((e) => ({ ...e }))
    const simulation = forceSimulation<SimNode>(simNodes)
      .force('charge', forceManyBody().strength(-170))
      .force(
        'link',
        forceLink<SimNode, { source: string; target: string }>(simEdges)
          .id((d) => d.id)
          .distance(95)
          .strength(0.4),
      )
      .force('center', forceCenter(WIDTH / 2, HEIGHT / 2))
      .force('collide', forceCollide<SimNode>().radius((d) => radiusFor(d.weight) + 8))
    simRef.current = simulation

    let raf = 0
    const loop = () => {
      setFrame((f) => f + 1)
      if (simulation.alpha() > 0.011) raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    simulation.on('tick', () => {
      // rAF drives the repaint; the tick itself stays cheap.
    })
    return () => {
      cancelAnimationFrame(raf)
      simulation.stop()
    }
  }, [nodes, edges])

  /** Wake the simulation (after a drag) and keep repainting until it cools. */
  const reheat = useCallback(() => {
    const simulation = simRef.current
    if (!simulation) return
    simulation.alphaTarget(0.12).restart()
    const loop = () => {
      setFrame((f) => f + 1)
      if ((simRef.current?.alpha() ?? 0) > 0.011) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }, [])

  const cool = useCallback(() => {
    simRef.current?.alphaTarget(0)
  }, [])

  return { nodesRef, frame, reheat, cool }
}

// ---------------------------------------------------------------------------
// Canvas - zoom, pan, drag, hover, select. One engine for both lenses.
// ---------------------------------------------------------------------------

function GraphCanvas({
  nodes,
  edges,
  groupColours,
  hiddenGroups,
  selectedId,
  pathEdges,
  pathFrom,
  onSelect,
  focusId,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  groupColours: Map<string, string>
  hiddenGroups: Set<string>
  selectedId: string | null
  pathEdges: MapEdge[] | null
  pathFrom: string | null
  onSelect: (id: string | null) => void
  focusId: string | null
}) {
  const visibleNodes = useMemo(
    () => nodes.filter((n) => !hiddenGroups.has(n.group)),
    [nodes, hiddenGroups],
  )
  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes])
  const visibleEdges = useMemo(
    () => edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target)),
    [edges, visibleIds],
  )

  const { nodesRef, reheat, cool } = useLiveSimulation(visibleNodes, visibleEdges)
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const panRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)
  const dragRef = useRef<{ id: string } | null>(null)

  const neighbourIds = useMemo(() => {
    const focus = selectedId ?? hoveredId
    if (!focus) return null
    const ids = new Set<string>([focus])
    for (const e of visibleEdges) {
      if (e.source === focus) ids.add(e.target)
      if (e.target === focus) ids.add(e.source)
    }
    return ids
  }, [selectedId, hoveredId, visibleEdges])

  const pathNodeIds = useMemo(() => {
    if (!pathEdges) return null
    const ids = new Set<string>()
    for (const e of pathEdges) {
      ids.add(e.source)
      ids.add(e.target)
    }
    return ids
  }, [pathEdges])

  const pathEdgeKeys = useMemo(
    () => pathEdges ? new Set(pathEdges.map((e) => `${e.source}|${e.label}|${e.target}`)) : null,
    [pathEdges],
  )

  // Centre the view on a newly focused node (search or panel click).
  useEffect(() => {
    if (!focusId) return
    const node = nodesRef.current.find((n) => n.id === focusId)
    if (!node || node.x === undefined || node.y === undefined) return
    const k = Math.max(1.25, transform.k)
    setTransform({ x: WIDTH / 2 - node.x * k, y: HEIGHT / 2 - node.y * k, k })
    // transform.k is read once to keep any user zoom level - not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  const toGraphPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const px = ((clientX - rect.left) / rect.width) * WIDTH
    const py = ((clientY - rect.top) / rect.height) * HEIGHT
    return { x: (px - transform.x) / transform.k, y: (py - transform.y) / transform.k }
  }

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault()
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12
    setTransform((t) => {
      const k = Math.min(4, Math.max(0.35, t.k * factor))
      if (k === t.k) return t
      const svg = svgRef.current
      if (!svg) return { ...t, k }
      const rect = svg.getBoundingClientRect()
      const px = ((event.clientX - rect.left) / rect.width) * WIDTH
      const py = ((event.clientY - rect.top) / rect.height) * HEIGHT
      // Zoom towards the cursor: keep the point under it stationary.
      return { x: px - ((px - t.x) / t.k) * k, y: py - ((py - t.y) / t.k) * k, k }
    })
  }

  const onPointerDownBackground = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current) return
    panRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      ox: transform.x,
      oy: transform.y,
    }
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (drag) {
      const point = toGraphPoint(event.clientX, event.clientY)
      const node = nodesRef.current.find((n) => n.id === drag.id)
      if (node) {
        node.fx = point.x
        node.fy = point.y
      }
      return
    }
    const pan = panRef.current
    if (pan) {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const dx = ((event.clientX - pan.startX) / rect.width) * WIDTH
      const dy = ((event.clientY - pan.startY) / rect.height) * HEIGHT
      setTransform((t) => ({ ...t, x: pan.ox + dx, y: pan.oy + dy }))
    }
  }

  const endPointer = () => {
    if (dragRef.current) {
      const node = nodesRef.current.find((n) => n.id === dragRef.current?.id)
      if (node) {
        node.fx = null
        node.fy = null
      }
      dragRef.current = null
      cool()
    }
    panRef.current = null
  }

  const startNodeDrag = (event: ReactPointerEvent, id: string) => {
    event.stopPropagation()
    dragRef.current = { id }
    const point = toGraphPoint(event.clientX, event.clientY)
    const node = nodesRef.current.find((n) => n.id === id)
    if (node) {
      node.fx = point.x
      node.fy = point.y
    }
    reheat()
  }

  const labelledIds = useMemo(() => {
    // Labels for the most connected nodes; everything gets one when zoomed in
    // or when it is part of the current focus.
    const byWeight = [...visibleNodes].sort((a, b) => b.weight - a.weight)
    return new Set(
      byWeight.slice(0, transform.k >= 1.3 ? visibleNodes.length : 24).map((n) => n.id),
    )
  }, [visibleNodes, transform.k])

  const zoomBy = (factor: number) =>
    setTransform((t) => {
      const k = Math.min(4, Math.max(0.35, t.k * factor))
      const cx = WIDTH / 2
      const cy = HEIGHT / 2
      return { x: cx - ((cx - t.x) / t.k) * k, y: cy - ((cy - t.y) / t.k) * k, k }
    })

  return (
    <div className='relative'>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role='application'
        aria-label='Knowledge map - drag to pan, scroll to zoom, click a node to explore it'
        tabIndex={0}
        className='rp-focus block h-[520px] w-full cursor-grab touch-none select-none rounded-[calc(var(--rp-radius)+2px)] active:cursor-grabbing lg:h-[600px]'
        style={{ background: 'var(--rp-surface-2)' }}
        onWheel={onWheel}
        onPointerDown={onPointerDownBackground}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerLeave={endPointer}
        onClick={() => onSelect(null)}
      >
        <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
          <g>
            {visibleEdges.map((edge, i) => {
              const from = nodesRef.current.find((n) => n.id === edge.source)
              const to = nodesRef.current.find((n) => n.id === edge.target)
              if (!from?.x || !to?.x || from.y === undefined || to.y === undefined) return null
              const key = `${edge.source}|${edge.label}|${edge.target}`
              const onPath = pathEdgeKeys?.has(key) ?? false
              const focus = selectedId ?? hoveredId
              const touchesFocus = focus !== null &&
                (edge.source === focus || edge.target === focus)
              const dimmed = (pathEdgeKeys && !onPath) ||
                (focus !== null && !touchesFocus && !pathEdgeKeys)
              const showLabel = (touchesFocus || onPath) && transform.k >= 0.7
              const mx = (from.x + to.x) / 2
              const my = (from.y + to.y) / 2
              return (
                <g key={`${key}-${i}`}>
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={onPath
                      ? 'var(--rp-accent)'
                      : touchesFocus
                      ? 'var(--rp-accent)'
                      : 'var(--rp-ink-3)'}
                    strokeWidth={onPath ? 3 : touchesFocus ? 2 : Math.max(1, edge.weight)}
                    strokeOpacity={dimmed ? 0.07 : onPath || touchesFocus ? 0.9 : 0.42}
                  />
                  {showLabel && edge.label
                    ? (
                      <text
                        x={mx}
                        y={my - 4}
                        textAnchor='middle'
                        fontSize={11}
                        fill='var(--rp-ink-2)'
                        stroke='var(--rp-surface-2)'
                        strokeWidth={3.5}
                        paintOrder='stroke'
                        style={{ pointerEvents: 'none' }}
                      >
                        {edge.label}
                      </text>
                    )
                    : null}
                </g>
              )
            })}
          </g>
          <g>
            {visibleNodes.map((node) => {
              const sim = nodesRef.current.find((n) => n.id === node.id)
              if (!sim || sim.x === undefined || sim.y === undefined) return null
              const r = radiusFor(node.weight)
              const isSelected = node.id === selectedId
              const isPathStart = node.id === pathFrom
              const inNeighbourhood = neighbourIds?.has(node.id) ?? true
              const onPath = pathNodeIds?.has(node.id) ?? false
              const dimmed = (pathNodeIds && !onPath) || (!pathNodeIds && !inNeighbourhood)
              const showLabel = labelledIds.has(node.id) || isSelected || isPathStart ||
                node.id === hoveredId || (neighbourIds?.has(node.id) ?? false) || onPath
              return (
                <g
                  key={node.id}
                  role='button'
                  tabIndex={0}
                  aria-label={`${node.label} - ${node.group || 'entity'}`}
                  className='cursor-pointer focus:outline-none'
                  opacity={dimmed ? 0.18 : 1}
                  onPointerDown={(event) => startNodeDrag(event, node.id)}
                  onPointerEnter={() => setHoveredId(node.id)}
                  onPointerLeave={() => setHoveredId((h) => (h === node.id ? null : h))}
                  onClick={(event) => {
                    event.stopPropagation()
                    onSelect(node.id)
                  }}
                  onKeyDown={(event: ReactKeyboardEvent) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelect(node.id)
                    }
                  }}
                >
                  <circle
                    cx={sim.x}
                    cy={sim.y}
                    r={r}
                    fill={groupColours.get(node.group) ?? 'var(--rp-cat-1)'}
                    fillOpacity={0.9}
                    stroke={isSelected || isPathStart ? 'var(--rp-ink)' : 'var(--rp-surface)'}
                    strokeWidth={isSelected || isPathStart ? 3 : 1.5}
                  />
                  {showLabel
                    ? (
                      <text
                        x={sim.x}
                        y={sim.y - r - 6}
                        textAnchor='middle'
                        fontSize={13}
                        fontWeight={isSelected ? 600 : 400}
                        fill='var(--rp-ink)'
                        stroke='var(--rp-surface-2)'
                        strokeWidth={4}
                        paintOrder='stroke'
                        style={{ pointerEvents: 'none' }}
                      >
                        {shortLabel(node.label)}
                      </text>
                    )
                    : null}
                </g>
              )
            })}
          </g>
        </g>
      </svg>
      <div className='absolute bottom-3 right-3 flex flex-col gap-1'>
        <button
          type='button'
          aria-label='Zoom in'
          onClick={() => zoomBy(1.3)}
          className='rp-btn rp-btn-outline h-8 w-8 bg-surface p-0 text-base'
        >
          +
        </button>
        <button
          type='button'
          aria-label='Zoom out'
          onClick={() => zoomBy(1 / 1.3)}
          className='rp-btn rp-btn-outline h-8 w-8 bg-surface p-0 text-base'
        >
          −
        </button>
        <button
          type='button'
          aria-label='Reset view'
          onClick={() => setTransform({ x: 0, y: 0, k: 1 })}
          className='rp-btn rp-btn-outline h-8 w-8 bg-surface p-0 text-xs'
        >
          ⤢
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Node search - type to find an entity, click to focus it.
// ---------------------------------------------------------------------------

function NodeSearch({
  nodes,
  onPick,
}: {
  nodes: MapNode[]
  onPick: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    return nodes.filter((n) => n.label.toLowerCase().includes(q)).slice(0, 8)
  }, [query, nodes])

  return (
    <div className='relative w-full max-w-xs'>
      <input
        type='text'
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder='Find in the map…'
        aria-label='Find an entity in the map'
        className='rp-input h-9 w-full text-sm'
      />
      {matches.length > 0
        ? (
          <ul className='absolute z-20 mt-1 w-full overflow-hidden rounded-[var(--rp-radius)] border border-line bg-surface shadow-lg'>
            {matches.map((node) => (
              <li key={node.id}>
                <button
                  type='button'
                  onClick={() => {
                    onPick(node.id)
                    setQuery('')
                  }}
                  className='w-full px-3 py-2 text-left text-sm text-ink hover:bg-[var(--rp-surface-2)]'
                >
                  {node.label}
                  <span className='ml-2 text-xs text-ink-3'>{node.group}</span>
                </button>
              </li>
            ))}
          </ul>
        )
        : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Evidence - the resources that actually mention the selected entity.
// ---------------------------------------------------------------------------

function EvidenceList({ slug, name }: { slug: string; name: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['graph-evidence', slug, name],
    queryFn: () => searchTenantFull(slug, name, { mode: 'hybrid' }),
    staleTime: 5 * 60 * 1000,
  })
  if (isLoading) {
    return (
      <div className='space-y-2'>
        <Skeleton className='h-10' />
        <Skeleton className='h-10' />
      </div>
    )
  }
  const resources = (data?.resources ?? []).slice(0, 3)
  if (resources.length === 0) {
    return <p className='text-xs text-ink-3'>No indexed passages mention this yet.</p>
  }
  return (
    <ul className='space-y-2'>
      {resources.map((resource) => (
        <li key={resource.id}>
          <Link
            to={`/t/${slug}/library/${resource.id}`}
            className='block rounded-[var(--rp-radius)] border border-line bg-surface p-2.5 transition-colors hover:bg-[var(--rp-surface-2)]'
          >
            <p className='rp-clamp-2 text-xs font-medium text-ink'>{resource.title}</p>
            {resource.matchedPassage
              ? <p className='rp-clamp-2 mt-1 text-xs text-ink-3'>{resource.matchedPassage}</p>
              : null}
          </Link>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <aside
      aria-label='Map details'
      className='flex min-h-[280px] flex-col gap-4 rounded-[calc(var(--rp-radius)+2px)] border border-line bg-surface p-4 lg:h-[600px] lg:overflow-y-auto'
    >
      {children}
    </aside>
  )
}

function EntityPanel({
  slug,
  node,
  edges,
  groupColour,
  pathState,
  onSelect,
  onExpand,
  onArmPath,
  onClearPath,
  expanding,
}: {
  slug: string
  node: MapNode
  edges: MapEdge[]
  groupColour: string
  pathState: { from: string | null; path: MapEdge[] | null; noPath: boolean }
  onSelect: (id: string) => void
  onExpand: () => void
  onArmPath: () => void
  onClearPath: () => void
  expanding: boolean
}) {
  const connections = useMemo(() => {
    const grouped = new Map<string, { other: string; outgoing: boolean }[]>()
    for (const edge of edges) {
      if (edge.source !== node.id && edge.target !== node.id) continue
      const outgoing = edge.source === node.id
      const other = outgoing ? edge.target : edge.source
      const label = edge.label || 'related to'
      const list = grouped.get(label)
      if (list) list.push({ other, outgoing })
      else grouped.set(label, [{ other, outgoing }])
    }
    return [...grouped.entries()]
  }, [edges, node.id])

  return (
    <>
      <div>
        <div className='flex items-start justify-between gap-2'>
          <h2 className='font-display text-lg leading-tight text-ink'>{node.label}</h2>
          <span
            className='mt-1 inline-block h-3 w-3 shrink-0 rounded-full'
            style={{ background: groupColour }}
            aria-hidden='true'
          />
        </div>
        <p className='mt-0.5 text-xs uppercase tracking-wide text-ink-3'>
          {node.group || 'Entity'} · {connections.reduce((n, [, list]) => n + list.length, 0)}{' '}
          connections
        </p>
      </div>

      <div className='flex flex-wrap gap-1.5'>
        <button
          type='button'
          onClick={onExpand}
          disabled={expanding}
          className='rp-btn rp-btn-outline h-8 px-2.5 text-xs'
        >
          {expanding ? 'Expanding…' : 'Expand connections'}
        </button>
        <button
          type='button'
          onClick={pathState.from === node.id ? onClearPath : onArmPath}
          className={`rp-btn h-8 px-2.5 text-xs ${
            pathState.from === node.id ? 'rp-btn-primary' : 'rp-btn-outline'
          }`}
        >
          {pathState.from === node.id ? 'Cancel trace' : 'Trace a connection'}
        </button>
      </div>

      {pathState.from === node.id && !pathState.path
        ? (
          <p className='rounded-[var(--rp-radius)] border border-line bg-surface-2 p-2.5 text-xs text-ink-2'>
            Now select any other entity to trace how the two are connected.
          </p>
        )
        : null}
      {pathState.noPath
        ? (
          <p
            className='rounded-[var(--rp-radius)] border p-2.5 text-xs'
            style={{
              borderColor: 'var(--rp-warn-line)',
              background: 'var(--rp-warn-bg)',
              color: 'var(--rp-warn-ink)',
            }}
          >
            No connection found between these two in the current map.
          </p>
        )
        : null}
      {pathState.path && pathState.path.length > 0
        ? (
          <div className='rounded-[var(--rp-radius)] border border-line bg-surface-2 p-2.5'>
            <p className='text-xs font-medium uppercase tracking-wide text-ink-3'>Connection</p>
            <ol className='mt-1.5 space-y-1'>
              {pathState.path.map((step, i) => (
                <li key={i} className='text-xs text-ink'>
                  <span className='font-medium'>{step.source}</span>{' '}
                  <span className='text-ink-3'>{step.label || 'related to'} →</span>{' '}
                  <span className='font-medium'>{step.target}</span>
                </li>
              ))}
            </ol>
            <button
              type='button'
              onClick={onClearPath}
              className='rp-btn rp-btn-ghost mt-2 h-7 px-2 text-xs'
            >
              Clear
            </button>
          </div>
        )
        : null}

      {connections.length > 0
        ? (
          <div>
            <h3 className='text-xs font-medium uppercase tracking-wide text-ink-3'>Connections</h3>
            <div className='mt-2 space-y-2.5'>
              {connections.map(([label, list]) => (
                <div key={label}>
                  <p className='text-xs italic text-ink-2'>{label}</p>
                  <div className='mt-1 flex flex-wrap gap-1.5'>
                    {list.map(({ other }) => (
                      <button
                        key={other}
                        type='button'
                        onClick={() => onSelect(other)}
                        className='rp-chip text-xs'
                      >
                        {other}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
        : <p className='text-xs text-ink-3'>No extracted relations for this entity yet.</p>}

      <div>
        <h3 className='text-xs font-medium uppercase tracking-wide text-ink-3'>Mentioned in</h3>
        <div className='mt-2'>
          <EvidenceList slug={slug} name={node.label} />
        </div>
      </div>

      <div className='mt-auto flex flex-wrap gap-1.5 border-t border-line pt-3'>
        <Link
          to={`/t/${slug}/entity/${encodeURIComponent(node.label)}`}
          className='rp-btn rp-btn-outline h-8 px-2.5 text-xs'
        >
          Open dossier
        </Link>
        <Link
          to={`/t/${slug}/assistant?ask=${
            encodeURIComponent(`What does the research say about ${node.label}?`)
          }`}
          className='rp-btn rp-btn-primary h-8 px-2.5 text-xs'
        >
          Ask about this
        </Link>
      </div>
    </>
  )
}

function OverviewPanel({
  nodes,
  edges,
  groupColours,
  hiddenGroups,
  onToggleGroup,
  onSelect,
  mode,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  groupColours: Map<string, string>
  hiddenGroups: Set<string>
  onToggleGroup: (group: string) => void
  onSelect: (id: string) => void
  mode: Mode
}) {
  const top = useMemo(() => [...nodes].sort((a, b) => b.weight - a.weight).slice(0, 8), [nodes])
  return (
    <>
      <div>
        <h2 className='font-display text-lg text-ink'>
          {mode === 'entity' ? 'The connected corpus' : 'How themes overlap'}
        </h2>
        <p className='mt-1 text-sm text-ink-2'>
          {mode === 'entity'
            ? `${nodes.length} entities linked by ${edges.length} extracted relations. Click any node to see its evidence, or trace how two entities connect.`
            : `Categories that appear on the same resources sit closer together. Click one to see what it pairs with.`}
        </p>
      </div>

      {groupColours.size > 1
        ? (
          <div>
            <h3 className='text-xs font-medium uppercase tracking-wide text-ink-3'>Groups</h3>
            <div className='mt-2 flex flex-wrap gap-1.5'>
              {[...groupColours.entries()].map(([group, colour]) => (
                <button
                  key={group}
                  type='button'
                  aria-pressed={!hiddenGroups.has(group)}
                  onClick={() => onToggleGroup(group)}
                  className={`rp-chip text-xs ${hiddenGroups.has(group) ? 'opacity-40' : ''}`}
                >
                  <span
                    className='mr-1 inline-block h-2.5 w-2.5 rounded-full'
                    style={{ background: colour }}
                    aria-hidden='true'
                  />
                  {group || 'Entity'}
                </button>
              ))}
            </div>
          </div>
        )
        : null}

      <div>
        <h3 className='text-xs font-medium uppercase tracking-wide text-ink-3'>Most connected</h3>
        <ul className='mt-2 space-y-1'>
          {top.map((node) => (
            <li key={node.id}>
              <button
                type='button'
                onClick={() => onSelect(node.id)}
                className='flex w-full items-center justify-between gap-2 rounded-[var(--rp-radius)] px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-[var(--rp-surface-2)]'
              >
                <span className='truncate'>{node.label}</span>
                <span className='shrink-0 text-xs text-ink-3'>{node.weight}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

function ConceptPanel({
  slug,
  node,
  edges,
  labelById,
}: {
  slug: string
  node: MapNode
  edges: MapEdge[]
  labelById: Map<string, string>
}) {
  const related = edges
    .filter((e) => e.source === node.id || e.target === node.id)
    .map((e) => ({
      otherId: e.source === node.id ? e.target : e.source,
      count: e.weight,
    }))
    .sort((a, b) => b.count - a.count)
  const isTopic = node.id.startsWith('topic:')
  const slugPart = node.id.split(':')[1] ?? ''
  return (
    <>
      <div>
        <h2 className='font-display text-lg text-ink'>{node.label}</h2>
        <p className='mt-0.5 text-xs uppercase tracking-wide text-ink-3'>
          {isTopic ? 'Topic' : 'Kind'} · on {node.weight}{' '}
          {node.weight === 1 ? 'resource' : 'resources'}
        </p>
      </div>
      {related.length > 0
        ? (
          <div>
            <h3 className='text-xs font-medium uppercase tracking-wide text-ink-3'>
              Appears together with
            </h3>
            <ul className='mt-2 space-y-1'>
              {related.map(({ otherId, count }) => (
                <li
                  key={otherId}
                  className='flex items-center justify-between gap-2 text-sm text-ink'
                >
                  <span className='truncate'>{labelById.get(otherId) ?? otherId}</span>
                  <span className='shrink-0 text-xs text-ink-3'>
                    {count} {count === 1 ? 'resource' : 'resources'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )
        : <p className='text-xs text-ink-3'>No overlaps recorded yet.</p>}
      {isTopic
        ? (
          <div className='mt-auto border-t border-line pt-3'>
            <Link
              to={`/t/${slug}/library?topic=${encodeURIComponent(slugPart)}`}
              className='rp-btn rp-btn-primary h-8 px-2.5 text-xs'
            >
              View these resources
            </Link>
          </div>
        )
        : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const options: { value: Mode; label: string }[] = [
    { value: 'entity', label: 'Entity graph' },
    { value: 'concept', label: 'Concept map' },
  ]
  return (
    <div
      role='group'
      aria-label='Graph mode'
      className='inline-flex rounded-[calc(var(--rp-radius)+2px)] border border-line bg-surface-2 p-1'
    >
      {options.map((option) => (
        <button
          key={option.value}
          type='button'
          aria-pressed={mode === option.value}
          onClick={() => onChange(option.value)}
          className={`rp-focus rounded-[var(--rp-radius)] px-3 py-1.5 text-sm font-medium transition-colors duration-150 ${
            mode === option.value
              ? 'bg-surface text-ink shadow-sm'
              : 'text-ink-3 hover:bg-[var(--rp-surface-3)] hover:text-[var(--rp-ink)]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function GraphPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const slug = config.slug
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('entity')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [hiddenGroups, setHiddenGroups] = useState<Set<string>>(new Set())
  const [pathFrom, setPathFrom] = useState<string | null>(null)
  const [path, setPath] = useState<MapEdge[] | null>(null)
  const [noPath, setNoPath] = useState(false)
  const [extraGraph, setExtraGraph] = useState<RelationsGraph | null>(null)
  const [expanding, setExpanding] = useState(false)

  const relationsQuery = useQuery({
    queryKey: ['relations-graph', slug],
    queryFn: () => getRelationsGraph(slug),
    staleTime: 5 * 60 * 1000,
    enabled: mode === 'entity',
  })

  const conceptQuery = useQuery({
    queryKey: ['concept-graph', slug],
    queryFn: () => getGraph(slug, 'topic', 'kind'),
    staleTime: 5 * 60 * 1000,
    enabled: mode === 'concept',
  })

  const labelsetsQuery = useQuery({
    queryKey: ['labelsets', slug],
    queryFn: () => getLabelsets(slug),
    staleTime: 5 * 60 * 1000,
  })
  // Touch so the query stays mounted for other graph surfaces.
  void labelsetsQuery.data

  // Merge the base relations graph with any expanded neighbourhoods.
  const entityGraph = useMemo(() => {
    const base = relationsQuery.data
    if (!base) return null
    if (!extraGraph) return base
    const nodeIds = new Set(base.nodes.map((n) => n.id))
    const nodes = [...base.nodes]
    for (const node of extraGraph.nodes) {
      if (!nodeIds.has(node.id)) {
        nodeIds.add(node.id)
        nodes.push(node)
      }
    }
    const edgeKeys = new Set(base.edges.map((e) => `${e.source}|${e.label}|${e.target}`))
    const edges = [...base.edges]
    for (const edge of extraGraph.edges) {
      const key = `${edge.source}|${edge.label}|${edge.target}`
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key)
        edges.push(edge)
      }
    }
    return { nodes, edges }
  }, [relationsQuery.data, extraGraph])

  const { nodes, edges } = useMemo((): { nodes: MapNode[]; edges: MapEdge[] } => {
    if (mode === 'entity') {
      if (!entityGraph) return { nodes: [], edges: [] }
      return {
        nodes: entityGraph.nodes.map((n) => ({
          id: n.id,
          label: n.id,
          group: n.group || 'Entity',
          weight: n.weight,
        })),
        edges: entityGraph.edges.map((e) => ({ ...e, weight: 1 })),
      }
    }
    const data = conceptQuery.data
    if (!data) return { nodes: [], edges: [] }
    return {
      nodes: data.nodes.map((n) => ({
        id: n.id,
        label: n.label,
        group: n.group === 'primary' ? 'Topic' : 'Kind',
        weight: n.weight,
      })),
      edges: data.edges.map((e) => ({ ...e, label: '', weight: Math.min(4, e.weight) })),
    }
  }, [mode, entityGraph, conceptQuery.data])

  const groupColours = useMemo(() => buildGroupColours(nodes), [nodes])
  const labelById = useMemo(() => new Map(nodes.map((n) => [n.id, n.label])), [nodes])
  const selected = selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null

  const select = useCallback((id: string | null) => {
    if (id === null) {
      setSelectedId(null)
      return
    }
    setSelectedId(id)
    setNoPath(false)
    setPathFrom((from) => {
      if (from && from !== id) {
        const found = shortestPath(edges, from, id)
        setPath(found)
        setNoPath(found === null)
        return found === null ? from : null
      }
      return from
    })
  }, [edges])

  const focusAndSelect = (id: string) => {
    select(id)
    setFocusId(id)
    // Re-trigger centring even for the same node.
    setTimeout(() => setFocusId(null), 50)
  }

  const expandSelected = async () => {
    if (!selected) return
    setExpanding(true)
    try {
      const more = await getRelationsGraph(slug, selected.label)
      setExtraGraph((prev) => {
        if (!prev) return more
        return {
          nodes: [...prev.nodes, ...more.nodes],
          edges: [...prev.edges, ...more.edges],
        }
      })
    } catch {
      // The map keeps working with what it has.
    } finally {
      setExpanding(false)
    }
  }

  const switchMode = (next: Mode) => {
    setMode(next)
    setSelectedId(null)
    setPathFrom(null)
    setPath(null)
    setNoPath(false)
  }

  const loading = mode === 'entity' ? relationsQuery.isLoading : conceptQuery.isLoading
  const error = mode === 'entity' ? relationsQuery.error : conceptQuery.error
  const refetch = mode === 'entity' ? relationsQuery.refetch : conceptQuery.refetch

  return (
    <div className='mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8'>
      <div className='flex flex-wrap items-end justify-between gap-3'>
        <div>
          <h1 className='font-display text-3xl text-ink'>Knowledge map</h1>
          <p className='mt-1 text-sm text-ink-2'>
            {mode === 'entity'
              ? 'Live map of the entities and relations extracted from this corpus.'
              : 'How the taxonomy categories co-occur across the indexed content.'}
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <NodeSearch nodes={nodes} onPick={focusAndSelect} />
          <ModeToggle mode={mode} onChange={switchMode} />
        </div>
      </div>

      {pathFrom && !path
        ? (
          <div
            className='mt-4 rounded-[var(--rp-radius)] border p-3 text-sm'
            style={{ borderColor: 'var(--rp-accent)', color: 'var(--rp-ink)' }}
            role='status'
          >
            Tracing from <span className='font-semibold'>{labelById.get(pathFrom)}</span>{' '}
            - select any other entity to reveal the connection.
          </div>
        )
        : null}

      <div className='mt-5'>
        {loading
          ? (
            <Skeleton className='h-[520px] w-full rounded-[calc(var(--rp-radius)+2px)] lg:h-[600px]' />
          )
          : error
          ? (
            <ErrorCard
              message={error instanceof Error ? error.message : 'The map could not load.'}
              onRetry={() => void refetch()}
            />
          )
          : nodes.length === 0
          ? (
            <EmptyState
              title={mode === 'entity' ? 'No knowledge graph yet' : 'No taxonomy overlaps yet'}
              description={mode === 'entity'
                ? "The knowledge graph agent may still be working through the corpus, or hasn't been set up yet - configure it from Manage."
                : 'Once resources carry topics and kinds, their overlaps appear here.'}
            />
          )
          : (
            <div className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]'>
              <GraphCanvas
                nodes={nodes}
                edges={edges}
                groupColours={groupColours}
                hiddenGroups={hiddenGroups}
                selectedId={selectedId}
                pathEdges={path}
                pathFrom={pathFrom}
                onSelect={select}
                focusId={focusId}
              />
              <PanelShell>
                {selected && mode === 'entity'
                  ? (
                    <EntityPanel
                      slug={slug}
                      node={selected}
                      edges={edges}
                      groupColour={groupColours.get(selected.group) ?? 'var(--rp-cat-1)'}
                      pathState={{ from: pathFrom, path, noPath }}
                      onSelect={focusAndSelect}
                      onExpand={() => void expandSelected()}
                      onArmPath={() => {
                        setPathFrom(selected.id)
                        setPath(null)
                        setNoPath(false)
                      }}
                      onClearPath={() => {
                        setPathFrom(null)
                        setPath(null)
                        setNoPath(false)
                      }}
                      expanding={expanding}
                    />
                  )
                  : selected && mode === 'concept'
                  ? (
                    <ConceptPanel
                      slug={slug}
                      node={selected}
                      edges={edges}
                      labelById={labelById}
                    />
                  )
                  : (
                    <OverviewPanel
                      nodes={nodes}
                      edges={edges}
                      groupColours={groupColours}
                      hiddenGroups={hiddenGroups}
                      onToggleGroup={(group) =>
                        setHiddenGroups((prev) => {
                          const next = new Set(prev)
                          if (next.has(group)) next.delete(group)
                          else next.add(group)
                          return next
                        })}
                      onSelect={focusAndSelect}
                      mode={mode}
                    />
                  )}
              </PanelShell>
            </div>
          )}
      </div>
      {
        /* Dossier deep links are still reachable via the panel; keep navigate
          imported for future canvas-level shortcuts. */
      }
      {void navigate}
    </div>
  )
}
