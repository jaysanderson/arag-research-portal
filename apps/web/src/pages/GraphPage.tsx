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
import { EmptyState, ErrorCard } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// The knowledge map: a live, explorable graph of how the corpus connects.
// Two lenses share one canvas engine - the entity graph (relations the
// knowledge-graph agent extracted) and the concept map (how taxonomy
// categories co-occur). The canvas is full-bleed: it fills the viewport below
// the header, a floating navigator rail lets you browse by name, and selecting
// a node docks an evidence panel. A path mode answers "how are these two
// things connected?".
// ---------------------------------------------------------------------------

// The simulation runs in its own coordinate space centred on this origin; the
// canvas maps it into whatever pixel box the viewport gives us and a fit pass
// frames the result, so these two numbers are just the physics origin.
const SIM_W = 960
const SIM_H = 640

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
type Size = { w: number; h: number; ready: boolean }

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
      .force('center', forceCenter(SIM_W / 2, SIM_H / 2))
      .force('collide', forceCollide<SimNode>().radius((d) => radiusFor(d.weight) + 8))
    simRef.current = simulation

    // Settle the layout synchronously - instant, and immune to background-tab
    // rAF throttling. Live physics then only animates real interactions.
    simulation.stop()
    simulation.tick(280)
    setFrame((f) => f + 1)
    return () => {
      simulation.stop()
    }
  }, [nodes, edges])

  /** Wake the simulation (for a drag) and keep repainting until it cools. */
  const reheat = useCallback(() => {
    const simulation = simRef.current
    if (!simulation) return
    simulation.alphaTarget(0.25).restart()
    const loop = () => {
      setFrame((f) => f + 1)
      if ((simRef.current?.alpha() ?? 0) > 0.02) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  }, [])

  const cool = useCallback(() => {
    simRef.current?.alphaTarget(0)
  }, [])

  return { nodesRef, frame, reheat, cool }
}

// ---------------------------------------------------------------------------
// Element measurement - the canvas is sized to whatever the viewport gives it,
// so the SVG viewBox is 1:1 with pixels and pointer maths stay exact at any
// size (no letterboxing).
// ---------------------------------------------------------------------------

function useElementSize() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<Size>({ w: SIM_W, h: SIM_H, ready: false })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      setSize((prev) =>
        prev.ready && prev.w === rect.width && prev.h === rect.height
          ? prev
          : { w: rect.width, h: rect.height, ready: true }
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, size }
}

/** Frame the whole graph inside the current viewport with breathing room. */
function computeFit(nodes: SimNode[], w: number, h: number): Transform | null {
  const points = nodes.filter((n) => n.x !== undefined && n.y !== undefined)
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of points) {
    const x = node.x as number
    const y = node.y as number
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const pad = Math.min(120, Math.max(56, Math.min(w, h) * 0.12))
  const spanX = Math.max(1, maxX - minX)
  const spanY = Math.max(1, maxY - minY)
  const k = Math.max(0.35, Math.min(1.75, Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY)))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { x: w / 2 - cx * k, y: h / 2 - cy * k, k }
}

// ---------------------------------------------------------------------------
// Canvas - zoom, pan, drag, hover, select. One engine for both lenses. It
// measures itself and fills its container edge to edge.
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
  const { ref: sizeRef, size } = useElementSize()
  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 })
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const panRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null)
  // Set on pointer-up when a drag actually moved a node, so the click that
  // follows repositioning does not also fire a selection.
  const draggedRef = useRef(false)
  const fitSigRef = useRef<string>('')

  const fitView = useCallback(() => {
    const t = computeFit(nodesRef.current, size.w, size.h)
    if (t) setTransform(t)
  }, [nodesRef, size.w, size.h])

  // Frame the graph whenever the visible set changes to a new shape (first
  // load, mode switch, group toggle, expand). A pure resize keeps the user's
  // current view - only the node set drives a re-fit.
  useEffect(() => {
    if (!size.ready) return
    const sig = visibleNodes.map((n) => n.id).join('|')
    if (sig === fitSigRef.current) return
    const t = computeFit(nodesRef.current, size.w, size.h)
    if (t) {
      setTransform(t)
      fitSigRef.current = sig
    }
    // nodesRef is a stable ref; positions are settled by useLiveSimulation's
    // effect, which runs before this one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleNodes, size.ready, size.w, size.h])

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
    setTransform({ x: size.w / 2 - node.x * k, y: size.h / 2 - node.y * k, k })
    // transform.k is read once to keep any user zoom level - not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId])

  const toGraphPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const px = ((clientX - rect.left) / rect.width) * size.w
    const py = ((clientY - rect.top) / rect.height) * size.h
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
      const px = ((event.clientX - rect.left) / rect.width) * size.w
      const py = ((event.clientY - rect.top) / rect.height) * size.h
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
      drag.moved = true
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
      const dx = ((event.clientX - pan.startX) / rect.width) * size.w
      const dy = ((event.clientY - pan.startY) / rect.height) * size.h
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
      draggedRef.current = dragRef.current.moved
      dragRef.current = null
      cool()
    }
    panRef.current = null
  }

  const startNodeDrag = (event: ReactPointerEvent, id: string) => {
    event.stopPropagation()
    dragRef.current = { id, moved: false }
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
      byWeight.slice(0, transform.k >= 1.3 ? visibleNodes.length : 26).map((n) => n.id),
    )
  }, [visibleNodes, transform.k])

  const zoomBy = (factor: number) =>
    setTransform((t) => {
      const k = Math.min(4, Math.max(0.35, t.k * factor))
      const cx = size.w / 2
      const cy = size.h / 2
      return { x: cx - ((cx - t.x) / t.k) * k, y: cy - ((cy - t.y) / t.k) * k, k }
    })

  return (
    <div ref={sizeRef} className='absolute inset-0'>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size.w} ${size.h}`}
        preserveAspectRatio='xMidYMid meet'
        role='application'
        aria-label='Knowledge map - drag to pan, scroll to zoom, click a node to explore it'
        tabIndex={0}
        className='rp-focus block h-full w-full cursor-grab touch-none select-none active:cursor-grabbing'
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
                  aria-pressed={isSelected}
                  className='cursor-pointer focus:outline-none'
                  opacity={dimmed ? 0.18 : 1}
                  onPointerDown={(event) => startNodeDrag(event, node.id)}
                  onPointerEnter={() => setHoveredId(node.id)}
                  onPointerLeave={() => setHoveredId((h) => (h === node.id ? null : h))}
                  onClick={(event) => {
                    event.stopPropagation()
                    // A drag that moved the node should not also select it.
                    if (draggedRef.current) {
                      draggedRef.current = false
                      return
                    }
                    onSelect(node.id)
                  }}
                  onKeyDown={(event: ReactKeyboardEvent) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onSelect(node.id)
                    }
                  }}
                >
                  {isSelected
                    ? (
                      <circle
                        cx={sim.x}
                        cy={sim.y}
                        r={r + 6}
                        fill='none'
                        stroke='var(--rp-accent)'
                        strokeWidth={2}
                        strokeOpacity={0.55}
                      />
                    )
                    : null}
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
      <div className='absolute bottom-4 right-4 flex flex-col gap-1'>
        <button
          type='button'
          aria-label='Zoom in'
          onClick={() => zoomBy(1.3)}
          className='rp-btn rp-btn-outline rp-shadow-sm h-9 w-9 p-0 text-lg'
        >
          +
        </button>
        <button
          type='button'
          aria-label='Zoom out'
          onClick={() => zoomBy(1 / 1.3)}
          className='rp-btn rp-btn-outline rp-shadow-sm h-9 w-9 p-0 text-lg'
        >
          −
        </button>
        <button
          type='button'
          aria-label='Fit the whole map to view'
          title='Fit to view'
          onClick={fitView}
          className='rp-btn rp-btn-outline rp-shadow-sm h-9 w-9 p-0 text-sm'
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
    <div className='relative w-full sm:w-64'>
      <span
        aria-hidden='true'
        className='pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3'
      >
        <svg
          viewBox='0 0 20 20'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.7'
          className='h-4 w-4'
        >
          <circle cx='9' cy='9' r='5.5' />
          <path d='M13.5 13.5 17 17' strokeLinecap='round' />
        </svg>
      </span>
      <input
        type='text'
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder='Find in the map…'
        aria-label='Find an entity in the map'
        className='rp-input h-9 w-full pl-9 text-sm'
      />
      {matches.length > 0
        ? (
          <ul className='absolute z-40 mt-1 w-full overflow-hidden rounded-[calc(var(--rp-radius)+2px)] border border-line bg-surface rp-shadow-lg'>
            {matches.map((node) => (
              <li key={node.id}>
                <button
                  type='button'
                  onClick={() => {
                    onPick(node.id)
                    setQuery('')
                  }}
                  className='flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm text-ink hover:bg-[var(--rp-surface-2)]'
                >
                  <span className='truncate'>{node.label}</span>
                  <span className='shrink-0 text-xs text-ink-3'>{node.group}</span>
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
        <div className='rp-shimmer bg-surface-3 h-10 rounded-[6px]' aria-hidden='true' />
        <div className='rp-shimmer bg-surface-3 h-10 rounded-[6px]' aria-hidden='true' />
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
// Detail dock - slides in from the right (docks to a bottom sheet on mobile)
// when a node is selected. Holds the entity or concept evidence.
// ---------------------------------------------------------------------------

function DetailDock({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <aside
      aria-label='Selection details'
      className='rp-anim-fade absolute inset-x-0 bottom-0 z-30 flex max-h-[68%] flex-col overflow-hidden rounded-t-[16px] border border-line bg-surface rp-shadow-xl md:inset-x-auto md:right-3 md:top-3 md:bottom-3 md:max-h-none md:w-[360px] md:rounded-[calc(var(--rp-radius)+4px)]'
    >
      <button
        type='button'
        onClick={onClose}
        aria-label='Close details'
        className='rp-btn rp-btn-ghost absolute right-2 top-2 z-10 h-8 w-8 !px-0'
      >
        <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-4 w-4'>
          <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
        </svg>
      </button>
      <div className='flex flex-1 flex-col gap-4 overflow-y-auto p-4 pt-5'>
        {children}
      </div>
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
      <div className='pr-8'>
        <p className='rp-eyebrow text-ink-3'>Entity</p>
        <div className='mt-1 flex items-start gap-2'>
          <span
            className='mt-1.5 inline-block h-3 w-3 shrink-0 rounded-full'
            style={{ background: groupColour }}
            aria-hidden='true'
          />
          <h2 className='font-display text-lg leading-tight text-ink'>{node.label}</h2>
        </div>
        <p className='mt-1 text-xs uppercase tracking-wide text-ink-3'>
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

function ConceptPanel({
  slug,
  node,
  edges,
  labelById,
  onSelect,
}: {
  slug: string
  node: MapNode
  edges: MapEdge[]
  labelById: Map<string, string>
  onSelect: (id: string) => void
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

  /** Library link filtered to this node - and to a pair when other is given. */
  const libraryHref = (otherId?: string) => {
    const params = new URLSearchParams()
    params.set(isTopic ? 'topic' : 'kind', slugPart)
    if (otherId) {
      const otherIsTopic = otherId.startsWith('topic:')
      params.set(otherIsTopic ? 'topic' : 'kind', otherId.split(':')[1] ?? '')
    }
    return `/t/${slug}/library?${params.toString()}`
  }

  return (
    <>
      <div className='pr-8'>
        <p className='rp-eyebrow text-ink-3'>{isTopic ? 'Topic' : 'Kind'}</p>
        <h2 className='mt-1 font-display text-lg text-ink'>{node.label}</h2>
        <p className='mt-1 text-xs uppercase tracking-wide text-ink-3'>
          on {node.weight} {node.weight === 1 ? 'resource' : 'resources'}
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
                <li key={otherId} className='flex items-center justify-between gap-1.5'>
                  <button
                    type='button'
                    onClick={() =>
                      onSelect(otherId)}
                    className='min-w-0 truncate rounded-[var(--rp-radius)] px-1.5 py-1 text-left text-sm text-ink hover:bg-[var(--rp-surface-2)]'
                  >
                    {labelById.get(otherId) ?? otherId}
                  </button>
                  <Link
                    to={libraryHref(otherId)}
                    className='shrink-0 text-xs text-ink-3 underline-offset-2 hover:text-[var(--rp-ink)] hover:underline'
                    title='View the resources where both appear'
                  >
                    {count} {count === 1 ? 'resource' : 'resources'}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )
        : <p className='text-xs text-ink-3'>No overlaps recorded yet.</p>}
      <div className='mt-auto border-t border-line pt-3'>
        <Link
          to={libraryHref()}
          className='rp-btn rp-btn-primary h-8 px-2.5 text-xs'
        >
          View these {node.weight} {node.weight === 1 ? 'resource' : 'resources'}
        </Link>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Navigator rail - the way in. Legend, a most-connected shortlist and a
// prompt so a first-time user knows what they are looking at and where to
// start. Floats top-left on desktop, docks as a bottom sheet on mobile.
// ---------------------------------------------------------------------------

function NavigatorRail({
  nodes,
  edges,
  groupColours,
  hiddenGroups,
  onToggleGroup,
  onSelect,
  onClose,
  mode,
  selectedId,
  includeBuiltin,
  onToggleIncludeBuiltin,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  groupColours: Map<string, string>
  hiddenGroups: Set<string>
  onToggleGroup: (group: string) => void
  onSelect: (id: string) => void
  onClose: () => void
  mode: Mode
  selectedId: string | null
  includeBuiltin: boolean
  onToggleIncludeBuiltin: () => void
}) {
  const top = useMemo(() => [...nodes].sort((a, b) => b.weight - a.weight).slice(0, 10), [nodes])
  return (
    <aside
      aria-label='Map navigator'
      className='rp-anim-fade absolute inset-x-0 bottom-0 z-20 flex max-h-[60%] flex-col overflow-hidden rounded-t-[16px] border border-line bg-surface rp-shadow-lg md:inset-x-auto md:left-3 md:top-3 md:bottom-auto md:max-h-[calc(100%-1.5rem)] md:w-[300px] md:rounded-[calc(var(--rp-radius)+4px)]'
    >
      <div className='flex items-start justify-between gap-2 border-b border-line px-4 py-3'>
        <div className='min-w-0'>
          <h2 className='font-display text-base leading-tight text-ink'>
            {mode === 'entity' ? 'The connected corpus' : 'How themes overlap'}
          </h2>
          <p className='mt-1 text-xs leading-relaxed text-ink-2'>
            {mode === 'entity'
              ? `${nodes.length} entities linked by ${edges.length} relations. Pick one to see its evidence, or trace how two connect.`
              : 'Categories that share resources sit closer. Pick one to see what it pairs with.'}
          </p>
        </div>
        <button
          type='button'
          onClick={onClose}
          aria-label='Hide navigator'
          className='rp-btn rp-btn-ghost h-8 w-8 shrink-0 !px-0'
        >
          <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-4 w-4'>
            <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
          </svg>
        </button>
      </div>

      <div className='flex-1 overflow-y-auto px-4 py-3'>
        {mode === 'entity'
          ? (
            <div className='mb-4 border-b border-line pb-4'>
              <button
                type='button'
                role='switch'
                aria-checked={includeBuiltin}
                onClick={onToggleIncludeBuiltin}
                className='rp-focus inline-flex items-center gap-2 rounded-[var(--rp-radius)] py-0.5 text-xs font-medium text-ink-2 transition-colors duration-150 hover:text-ink'
              >
                <span
                  aria-hidden='true'
                  className='relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150'
                  style={{
                    borderColor: includeBuiltin ? 'transparent' : 'var(--rp-line)',
                    background: includeBuiltin ? 'var(--rp-accent)' : 'var(--rp-surface-2)',
                  }}
                >
                  <span
                    className='inline-block h-4 w-4 rounded-full bg-white rp-shadow-sm transition-transform duration-150'
                    style={{ transform: includeBuiltin ? 'translateX(18px)' : 'translateX(2px)' }}
                  />
                </span>
                Include built-in entities
              </button>
              <p className='mt-1 text-xs leading-relaxed text-ink-3'>
                Adds the platform's raw NER output (people, dates, places) alongside the curated
                relations - noisier, but complete.
              </p>
            </div>
          )
          : null}

        {groupColours.size > 1
          ? (
            <div className='mb-4'>
              <h3 className='text-xs font-medium uppercase tracking-wide text-ink-3'>
                Legend
                <span className='ml-1.5 font-normal normal-case tracking-normal text-ink-3'>
                  (tap to show or hide)
                </span>
              </h3>
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
          <ul className='mt-2 space-y-0.5'>
            {top.map((node) => {
              const active = node.id === selectedId
              return (
                <li key={node.id}>
                  <button
                    type='button'
                    onClick={() => onSelect(node.id)}
                    aria-current={active ? 'true' : undefined}
                    className={`flex w-full items-center gap-2 rounded-[var(--rp-radius)] px-2 py-1.5 text-left text-sm transition-colors ${
                      active
                        ? 'bg-[var(--rp-surface-2)] text-ink'
                        : 'text-ink hover:bg-[var(--rp-surface-2)]'
                    }`}
                  >
                    <span
                      className='inline-block h-2.5 w-2.5 shrink-0 rounded-full'
                      style={{ background: groupColours.get(node.group) ?? 'var(--rp-cat-1)' }}
                      aria-hidden='true'
                    />
                    <span className='min-w-0 flex-1 truncate'>{node.label}</span>
                    <span className='shrink-0 text-xs text-ink-3'>{node.weight}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </aside>
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
      className='inline-flex shrink-0 rounded-[calc(var(--rp-radius)+2px)] border border-line bg-surface-2 p-1'
    >
      {options.map((option) => (
        <button
          key={option.value}
          type='button'
          aria-pressed={mode === option.value}
          onClick={() => onChange(option.value)}
          className={`rp-focus rounded-[var(--rp-radius)] px-3 py-1.5 text-sm font-medium transition-colors duration-150 ${
            mode === option.value
              ? 'bg-surface text-ink rp-shadow-sm'
              : 'text-ink-3 hover:bg-[var(--rp-surface-3)] hover:text-[var(--rp-ink)]'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** A calm animated placeholder while the graph data loads. */
function CanvasLoading() {
  return (
    <div
      className='absolute inset-0 flex flex-col items-center justify-center gap-4'
      style={{ background: 'var(--rp-surface-2)' }}
      role='status'
    >
      <div
        className='h-8 w-8 animate-spin rounded-full border-2 border-line'
        style={{ borderTopColor: 'var(--rp-ink)' }}
        aria-hidden='true'
      />
      <p className='text-sm text-ink-2'>Building the map…</p>
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
  const [includeBuiltin, setIncludeBuiltin] = useState(false)
  const [railOpen, setRailOpen] = useState<boolean>(() =>
    typeof globalThis.matchMedia === 'function'
      ? globalThis.matchMedia('(min-width: 768px)').matches
      : true
  )

  const relationsQuery = useQuery({
    queryKey: ['relations-graph', slug, includeBuiltin],
    queryFn: () => getRelationsGraph(slug, undefined, includeBuiltin),
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
      edges: data.edges.map((e) => ({
        ...e,
        label: `together on ${e.weight} ${e.weight === 1 ? 'resource' : 'resources'}`,
        weight: Math.min(4, e.weight),
      })),
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

  // On a narrow screen the navigator and the detail dock both live at the
  // bottom - selecting a node hands the space to the detail dock.
  useEffect(() => {
    if (!selectedId) return
    if (
      typeof globalThis.matchMedia === 'function' &&
      !globalThis.matchMedia('(min-width: 768px)').matches
    ) {
      setRailOpen(false)
    }
  }, [selectedId])

  // Switching the built-in-entities toggle re-fetches the base graph under
  // the new filter - any expanded neighbourhood was fetched under the old
  // one, so drop it rather than mix filtered and unfiltered relations.
  useEffect(() => {
    setExtraGraph(null)
  }, [includeBuiltin])

  // Escape clears the current selection.
  useEffect(() => {
    if (!selectedId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [selectedId])

  const expandSelected = async () => {
    if (!selected) return
    setExpanding(true)
    try {
      const more = await getRelationsGraph(slug, selected.label, includeBuiltin)
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
  const hasGraph = !loading && !error && nodes.length > 0

  const subtitle = mode === 'entity'
    ? `${nodes.length} ${nodes.length === 1 ? 'entity' : 'entities'} · ${edges.length} ${
      edges.length === 1 ? 'relation' : 'relations'
    }`
    : `${nodes.length} ${nodes.length === 1 ? 'category' : 'categories'}`

  return (
    <div className='flex h-[calc(100dvh-65px)] flex-col overflow-hidden bg-app'>
      {
        /* Chrome - title, find and the lens toggle. Kept slim so the map owns
          the height below it. */
      }
      <div className='shrink-0 border-b border-line bg-surface px-4 py-2.5 sm:px-6'>
        <div className='flex flex-wrap items-center justify-between gap-x-4 gap-y-2'>
          <div className='min-w-0'>
            <h1 className='font-display text-xl leading-none text-ink sm:text-2xl'>
              Knowledge map
            </h1>
            {hasGraph
              ? <p className='mt-1 hidden text-xs text-ink-2 sm:block'>{subtitle}</p>
              : null}
          </div>
          <div className='flex min-w-0 flex-1 items-center justify-end gap-2 sm:flex-none'>
            <NodeSearch nodes={nodes} onPick={focusAndSelect} />
            <ModeToggle mode={mode} onChange={switchMode} />
          </div>
        </div>
      </div>

      {/* Canvas stage - the map fills it; panels float over it. */}
      <div className='relative min-h-0 flex-1'>
        {loading
          ? <CanvasLoading />
          : error
          ? (
            <div className='absolute inset-0 flex items-center justify-center p-6'>
              <div className='w-full max-w-md'>
                <ErrorCard
                  message={error instanceof Error ? error.message : 'The map could not load.'}
                  onRetry={() => void refetch()}
                />
              </div>
            </div>
          )
          : nodes.length === 0
          ? (
            <div className='absolute inset-0 flex items-center justify-center p-6'>
              <div className='w-full max-w-md'>
                <EmptyState
                  title={mode === 'entity' ? 'No knowledge graph yet' : 'No taxonomy overlaps yet'}
                  description={mode === 'entity'
                    ? "The knowledge graph agent may still be working through the corpus, or hasn't been set up yet - configure it from Manage."
                    : 'Once resources carry topics and kinds, their overlaps appear here.'}
                />
              </div>
            </div>
          )
          : (
            <>
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

              {/* Tracing status - floats over the canvas, out of the panels' way. */}
              {pathFrom && !path
                ? (
                  <div
                    className='rp-anim-fade absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-surface px-3.5 py-1.5 text-xs rp-shadow-md'
                    style={{ borderColor: 'var(--rp-accent)' }}
                    role='status'
                  >
                    <span
                      className='inline-block h-2 w-2 animate-pulse rounded-full'
                      style={{ background: 'var(--rp-accent)' }}
                      aria-hidden='true'
                    />
                    <span className='text-ink'>
                      Tracing from <span className='font-semibold'>{labelById.get(pathFrom)}</span>
                      {' '}
                      - pick another entity
                    </span>
                  </div>
                )
                : null}

              {/* Reopen affordance when the navigator is hidden. */}
              {!railOpen
                ? (
                  <button
                    type='button'
                    onClick={() => setRailOpen(true)}
                    className='rp-btn rp-btn-outline rp-shadow-md absolute left-3 top-3 z-20 h-9 gap-1.5 px-3 text-sm'
                  >
                    <svg
                      viewBox='0 0 20 20'
                      fill='none'
                      stroke='currentColor'
                      strokeWidth='1.7'
                      className='h-4 w-4'
                      aria-hidden='true'
                    >
                      <path d='M4 6h12M4 10h12M4 14h8' strokeLinecap='round' />
                    </svg>
                    Browse
                  </button>
                )
                : (
                  <NavigatorRail
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
                    onClose={() => setRailOpen(false)}
                    mode={mode}
                    selectedId={selectedId}
                    includeBuiltin={includeBuiltin}
                    onToggleIncludeBuiltin={() => setIncludeBuiltin((v) => !v)}
                  />
                )}

              {/* Detail dock - only when a node is selected. */}
              {selected
                ? (
                  <DetailDock onClose={() => select(null)}>
                    {mode === 'entity'
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
                      : (
                        <ConceptPanel
                          slug={slug}
                          node={selected}
                          edges={edges}
                          labelById={labelById}
                          onSelect={focusAndSelect}
                        />
                      )}
                  </DetailDock>
                )
                : null}

              {
                /* Interaction hint - desktop only, and only before a selection
                  claims the reader's attention. */
              }
              {!selected
                ? (
                  <p className='pointer-events-none absolute bottom-4 left-1/2 hidden -translate-x-1/2 text-xs text-ink-3 lg:block'>
                    Drag to pan · scroll to zoom · click a node to explore it
                  </p>
                )
                : null}
            </>
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
