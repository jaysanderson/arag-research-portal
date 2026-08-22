import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext } from 'react-router-dom'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import type { GraphData, Labelset } from '@research-portal/core'
import { getGraph, getLabelsets, getRelationsGraph } from '../api/client.ts'
import { EmptyState, ErrorCard, Skeleton } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

const WIDTH = 900
const HEIGHT = 600

type Mode = 'concept' | 'entity'

/** The relations graph shape, mirrored from `getRelationsGraph`'s return type. */
type RelationsGraph = Awaited<ReturnType<typeof getRelationsGraph>>
type RelationEdge = RelationsGraph['edges'][number]

// ---------------------------------------------------------------------------
// Force layout - run the simulation for a fixed number of ticks up front,
// then render the settled positions as plain SVG. No animation loop, so
// nothing to clean up and nothing that can jank. Generic over any
// {id, weight} node / {source, target} edge shape, so both the taxonomy
// co-occurrence graph and the entity relations graph share one pipeline.
// ---------------------------------------------------------------------------

type ForceNode = {
  id: string
  weight: number
  x?: number
  y?: number
  vx?: number
  vy?: number
  index?: number
}

type ForceEdge = { source: string; target: string }

type Position = { x: number; y: number }

function radiusFor(weight: number): number {
  return Math.max(6, Math.min(26, Math.sqrt(weight) * 3 + 6))
}

function forceLayout(
  nodes: { id: string; weight: number }[],
  edges: { source: string; target: string }[],
): Map<string, Position> {
  const positions = new Map<string, Position>()
  if (nodes.length === 0) return positions

  const simNodes: ForceNode[] = nodes.map((n) => ({ id: n.id, weight: n.weight }))
  const simEdges: ForceEdge[] = edges.map((e) => ({ source: e.source, target: e.target }))

  const simulation = forceSimulation<ForceNode>(simNodes)
    .force('charge', forceManyBody().strength(-140))
    .force(
      'link',
      forceLink<ForceNode, ForceEdge>(simEdges)
        .id((d) => d.id)
        .distance(90)
        .strength(0.35),
    )
    .force('center', forceCenter(WIDTH / 2, HEIGHT / 2))
    .force(
      'collide',
      forceCollide<ForceNode>().radius((d) => radiusFor(d.weight) + 6),
    )
    .stop()

  for (let i = 0; i < 150; i++) simulation.tick()

  for (const n of simNodes) {
    positions.set(n.id, { x: n.x ?? WIDTH / 2, y: n.y ?? HEIGHT / 2 })
  }
  return positions
}

// ---------------------------------------------------------------------------
// Categorical colour - stable hash of a group name onto six accent-ish hues
// that read in both themes (see the --rp-cat-* tokens in styles.css).
// ---------------------------------------------------------------------------

const CATEGORY_COLOURS = [
  'var(--rp-cat-1)',
  'var(--rp-cat-2)',
  'var(--rp-cat-3)',
  'var(--rp-cat-4)',
  'var(--rp-cat-5)',
  'var(--rp-cat-6)',
]

function hueForGroup(group: string): string {
  let hash = 0
  for (let i = 0; i < group.length; i++) {
    hash = (hash * 31 + group.charCodeAt(i)) >>> 0
  }
  return CATEGORY_COLOURS[hash % CATEGORY_COLOURS.length] ?? 'var(--rp-cat-1)'
}

// ---------------------------------------------------------------------------
// Mode toggle
// ---------------------------------------------------------------------------

function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const options: { value: Mode; label: string }[] = [
    { value: 'concept', label: 'Concept map' },
    { value: 'entity', label: 'Entity graph' },
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

// ---------------------------------------------------------------------------
// Side panels - the selected node's connections.
// ---------------------------------------------------------------------------

function PanelShell({
  title,
  countLabel,
  onClear,
  children,
}: {
  title: string
  countLabel: string
  onClear: () => void
  children: ReactNode
}) {
  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-5 shadow-sm'>
      <div className='flex items-start justify-between gap-2'>
        <div>
          <p className='text-xs font-semibold uppercase tracking-wide text-ink-3'>Selected</p>
          <h2 className='mt-0.5 text-base font-semibold tracking-tight text-ink'>{title}</h2>
        </div>
        <button
          type='button'
          onClick={onClear}
          className='rp-btn rp-btn-ghost h-auto shrink-0 px-2.5 py-1 text-xs'
        >
          Clear
        </button>
      </div>
      <p className='mt-3 text-xs font-semibold uppercase tracking-wide text-ink-3'>{countLabel}</p>
      {children}
    </div>
  )
}

function NeighbourPanel({
  graph,
  selectedId,
  onClear,
}: {
  graph: GraphData
  selectedId: string
  onClear: () => void
}) {
  const node = graph.nodes.find((n) => n.id === selectedId)
  const connections = graph.edges
    .filter((e) => e.source === selectedId || e.target === selectedId)
    .map((e) => {
      const otherId = e.source === selectedId ? e.target : e.source
      const other = graph.nodes.find((n) => n.id === otherId)
      return { id: otherId, label: other?.label ?? otherId, weight: e.weight }
    })
    .sort((a, b) => b.weight - a.weight)

  return (
    <PanelShell
      title={node?.label ?? selectedId}
      countLabel={`Connections (${connections.length})`}
      onClear={onClear}
    >
      {connections.length === 0
        ? <p className='mt-2 text-sm text-ink-3'>No co-occurring categories.</p>
        : (
          <ul className='mt-2 space-y-2'>
            {connections.map((c) => (
              <li key={c.id} className='text-sm text-ink-2'>
                <span className='font-medium text-ink'>{c.label}</span>
                <span className='text-ink-3'>
                  {' '}
                  - appears together in {c.weight} {c.weight === 1 ? 'document' : 'documents'}
                </span>
              </li>
            ))}
          </ul>
        )}
    </PanelShell>
  )
}

function EntityNeighbourPanel({
  graph,
  selectedId,
  slug,
  onClear,
}: {
  graph: RelationsGraph
  selectedId: string
  slug: string
  onClear: () => void
}) {
  const relations = graph.edges.filter((e) => e.source === selectedId || e.target === selectedId)

  return (
    <PanelShell
      title={selectedId}
      countLabel={`Relations (${relations.length})`}
      onClear={onClear}
    >
      <Link
        to={`/t/${slug}/entity/${encodeURIComponent(selectedId)}`}
        className='rp-focus mb-1 mt-2.5 inline-flex items-center gap-1 rounded-[4px] text-sm font-medium transition-colors duration-150'
        style={{ color: 'var(--rp-accent)' }}
      >
        Open dossier
        <span aria-hidden='true'>&rarr;</span>
      </Link>
      {relations.length === 0
        ? <p className='mt-2 text-sm text-ink-3'>No extracted relations for this entity.</p>
        : (
          <ul className='mt-2 space-y-2'>
            {relations.map((edge, index) => (
              <li
                key={`${edge.source}-${edge.label}-${edge.target}-${index}`}
                className='text-sm text-ink-2'
              >
                <span className='font-medium text-ink'>{edge.source}</span>
                <span className='text-ink-3'>- {edge.label} &rarr;</span>
                <span className='font-medium text-ink'>{edge.target}</span>
              </li>
            ))}
          </ul>
        )}
    </PanelShell>
  )
}

// ---------------------------------------------------------------------------
// Legends
// ---------------------------------------------------------------------------

function Legend(
  { primaryTitle, secondaryTitle }: { primaryTitle: string; secondaryTitle: string },
) {
  return (
    <div className='flex flex-wrap items-center gap-4 text-sm text-ink-2'>
      <span className='inline-flex items-center gap-2'>
        <span
          className='h-3 w-3 rounded-full'
          style={{ backgroundColor: 'var(--rp-primary)' }}
          aria-hidden='true'
        />
        {primaryTitle}
      </span>
      <span className='inline-flex items-center gap-2'>
        <span
          className='h-3 w-3 rounded-full'
          style={{ backgroundColor: 'var(--rp-accent)' }}
          aria-hidden='true'
        />
        {secondaryTitle}
      </span>
    </div>
  )
}

function EntityLegend({ groups }: { groups: string[] }) {
  if (groups.length === 0) return null
  return (
    <div className='flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-ink-2'>
      {groups.map((group) => (
        <span key={group} className='inline-flex items-center gap-2'>
          <span
            className='h-3 w-3 rounded-full'
            style={{ backgroundColor: hueForGroup(group) }}
            aria-hidden='true'
          />
          {group}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Concept map - taxonomy co-occurrence between the primary and secondary
// labelsets.
// ---------------------------------------------------------------------------

function ConceptGraph({
  graph,
  labelsets,
}: {
  graph: GraphData
  labelsets: Labelset[] | undefined
}) {
  const [positions, setPositions] = useState<Map<string, Position>>(new Map())
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    setSelectedId(null)
    setPositions(forceLayout(graph.nodes, graph.edges))
  }, [graph])

  const labelsetTitle = (id: string | undefined): string => {
    const found: Labelset | undefined = labelsets?.find((l) => l.id === id)
    return found?.title ?? id ?? 'Category'
  }

  const maxWeight = useMemo(
    () => graph.nodes.reduce((max, n) => Math.max(max, n.weight), 1),
    [graph],
  )
  const maxEdgeWeight = useMemo(
    () => graph.edges.reduce((max, e) => Math.max(max, e.weight), 1),
    [graph],
  )

  const neighbourIds = useMemo(() => {
    if (!selectedId) return new Set<string>()
    const ids = new Set<string>()
    for (const e of graph.edges) {
      if (e.source === selectedId) ids.add(e.target)
      if (e.target === selectedId) ids.add(e.source)
    }
    return ids
  }, [graph, selectedId])

  return (
    <div className='mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]'>
      <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-4 shadow-sm'>
        <div
          className='overflow-x-auto'
          tabIndex={0}
          aria-label='Knowledge graph canvas - scrollable'
        >
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className='h-auto w-full min-w-[640px]'
            role='img'
            aria-label='Taxonomy co-occurrence graph'
          >
            <rect
              x={0}
              y={0}
              width={WIDTH}
              height={HEIGHT}
              fill='transparent'
              onClick={() => setSelectedId(null)}
            />
            <g>
              {graph.edges.map((e, i) => {
                const from = positions.get(e.source)
                const to = positions.get(e.target)
                if (!from || !to) return null
                const touchesSelected = selectedId !== null &&
                  (e.source === selectedId || e.target === selectedId)
                const dimmed = selectedId !== null && !touchesSelected
                return (
                  <line
                    key={i}
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={touchesSelected ? 'var(--rp-accent)' : 'var(--rp-ink-3)'}
                    strokeWidth={Math.max(1, (e.weight / maxEdgeWeight) * 4)}
                    strokeOpacity={dimmed ? 0.08 : Math.max(0.3, e.weight / maxEdgeWeight)}
                  />
                )
              })}
            </g>
            <g>
              {graph.nodes.map((n) => {
                const pos = positions.get(n.id)
                if (!pos) return null
                const r = radiusFor(n.weight)
                const isSelected = n.id === selectedId
                const isNeighbour = neighbourIds.has(n.id)
                const dimmed = selectedId !== null && !isSelected && !isNeighbour
                const showLabel = isSelected || isNeighbour || n.weight >= maxWeight * 0.25
                const selectNode = (event: { stopPropagation: () => void }) => {
                  event.stopPropagation()
                  setSelectedId(n.id)
                }
                return (
                  <g
                    key={n.id}
                    opacity={dimmed ? 0.2 : 1}
                    onClick={selectNode}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        selectNode(event)
                      }
                    }}
                    tabIndex={0}
                    role='button'
                    aria-label={`Select node ${n.label}`}
                    style={{ cursor: 'pointer' }}
                  >
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={r}
                      fill={n.group === 'primary' ? 'var(--rp-primary)' : 'var(--rp-accent)'}
                      stroke='var(--rp-surface)'
                      strokeWidth={isSelected ? 3 : 1.5}
                    />
                    {showLabel && (
                      <text
                        x={pos.x + r + 5}
                        y={pos.y + 4}
                        fontSize={13}
                        fill='var(--rp-ink-2)'
                        className='select-none'
                      >
                        {n.label}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
        </div>
        <div className='mt-4 border-t border-line pt-4'>
          <Legend
            primaryTitle={labelsetTitle(graph.primary)}
            secondaryTitle={labelsetTitle(graph.secondary)}
          />
        </div>
      </div>

      {selectedId
        ? (
          <NeighbourPanel
            graph={graph}
            selectedId={selectedId}
            onClear={() => setSelectedId(null)}
          />
        )
        : (
          <div className='rounded-[calc(var(--rp-radius)+4px)] border border-dashed border-line bg-surface-2 p-5 text-center'>
            <p className='text-sm font-medium text-ink'>Click a node</p>
            <p className='mt-1 text-sm text-ink-3'>
              See its connections and how often they appear together.
            </p>
          </div>
        )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Entity graph - extracted entities and the relations between them.
// ---------------------------------------------------------------------------

function EntityGraph({ graph, slug }: { graph: RelationsGraph; slug: string }) {
  const [positions, setPositions] = useState<Map<string, Position>>(new Map())
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    setSelectedId(null)
    setPositions(forceLayout(graph.nodes, graph.edges))
  }, [graph])

  const maxWeight = useMemo(
    () => graph.nodes.reduce((max, n) => Math.max(max, n.weight), 1),
    [graph],
  )

  const groups = useMemo(
    () => [...new Set(graph.nodes.map((n) => n.group))].sort((a, b) => a.localeCompare(b)),
    [graph],
  )

  const neighbourIds = useMemo(() => {
    if (!selectedId) return new Set<string>()
    const ids = new Set<string>()
    for (const e of graph.edges) {
      if (e.source === selectedId) ids.add(e.target)
      if (e.target === selectedId) ids.add(e.source)
    }
    return ids
  }, [graph, selectedId])

  function edgeTouchesSelected(edge: RelationEdge): boolean {
    return selectedId !== null && (edge.source === selectedId || edge.target === selectedId)
  }

  return (
    <div className='mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]'>
      <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-4 shadow-sm'>
        <div
          className='overflow-x-auto'
          tabIndex={0}
          aria-label='Knowledge graph canvas - scrollable'
        >
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className='h-auto w-full min-w-[640px]'
            role='img'
            aria-label='Entity relations graph'
          >
            <defs>
              <marker
                id='rp-graph-arrow'
                viewBox='0 0 10 10'
                refX={9}
                refY={5}
                markerWidth={5.5}
                markerHeight={5.5}
                orient='auto-start-reverse'
              >
                <path d='M0 0L10 5L0 10z' fill='var(--rp-ink-3)' />
              </marker>
              <marker
                id='rp-graph-arrow-active'
                viewBox='0 0 10 10'
                refX={9}
                refY={5}
                markerWidth={5.5}
                markerHeight={5.5}
                orient='auto-start-reverse'
              >
                <path d='M0 0L10 5L0 10z' fill='var(--rp-accent)' />
              </marker>
            </defs>

            <rect
              x={0}
              y={0}
              width={WIDTH}
              height={HEIGHT}
              fill='transparent'
              onClick={() => setSelectedId(null)}
            />

            <g>
              {graph.edges.map((e, i) => {
                const from = positions.get(e.source)
                const to = positions.get(e.target)
                if (!from || !to) return null
                const touchesSelected = edgeTouchesSelected(e)
                const dimmed = selectedId !== null && !touchesSelected
                const midX = (from.x + to.x) / 2
                const midY = (from.y + to.y) / 2
                const markerId = touchesSelected ? 'rp-graph-arrow-active' : 'rp-graph-arrow'
                return (
                  <g key={i} opacity={dimmed ? 0.12 : 1}>
                    <line
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                      stroke={touchesSelected ? 'var(--rp-accent)' : 'var(--rp-ink-3)'}
                      strokeWidth={touchesSelected ? 1.75 : 1}
                      strokeOpacity={touchesSelected ? 0.85 : 0.4}
                      markerEnd={`url(#${markerId})`}
                    />
                    {touchesSelected && (
                      <text
                        x={midX}
                        y={midY - 4}
                        fontSize={10}
                        textAnchor='middle'
                        fill='var(--rp-ink-2)'
                        className='select-none'
                      >
                        {e.label}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>

            <g>
              {graph.nodes.map((n) => {
                const pos = positions.get(n.id)
                if (!pos) return null
                const r = radiusFor(n.weight)
                const isSelected = n.id === selectedId
                const isNeighbour = neighbourIds.has(n.id)
                const dimmed = selectedId !== null && !isSelected && !isNeighbour
                const showLabel = isSelected || isNeighbour || n.weight >= maxWeight * 0.25
                const selectNode = (event: { stopPropagation: () => void }) => {
                  event.stopPropagation()
                  setSelectedId(n.id)
                }
                return (
                  <g
                    key={n.id}
                    opacity={dimmed ? 0.2 : 1}
                    onClick={selectNode}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        selectNode(event)
                      }
                    }}
                    tabIndex={0}
                    role='button'
                    aria-label={`Select node ${n.id}`}
                    style={{ cursor: 'pointer' }}
                  >
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={r}
                      fill={hueForGroup(n.group)}
                      stroke='var(--rp-surface)'
                      strokeWidth={isSelected ? 3 : 1.5}
                    />
                    {showLabel && (
                      <text
                        x={pos.x + r + 5}
                        y={pos.y + 4}
                        fontSize={13}
                        fill='var(--rp-ink-2)'
                        className='select-none'
                      >
                        {n.id}
                      </text>
                    )}
                  </g>
                )
              })}
            </g>
          </svg>
        </div>
        <div className='mt-4 border-t border-line pt-4'>
          <EntityLegend groups={groups} />
        </div>
      </div>

      {selectedId
        ? (
          <EntityNeighbourPanel
            graph={graph}
            selectedId={selectedId}
            slug={slug}
            onClear={() => setSelectedId(null)}
          />
        )
        : (
          <div className='rounded-[calc(var(--rp-radius)+4px)] border border-dashed border-line bg-surface-2 p-5 text-center'>
            <p className='text-sm font-medium text-ink'>Click a node</p>
            <p className='mt-1 text-sm text-ink-3'>
              See its extracted relations to other entities.
            </p>
          </div>
        )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function GraphPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const slug = config.slug

  const [mode, setMode] = useState<Mode>('concept')

  const {
    data: graph,
    isLoading: isGraphLoading,
    isError: isGraphError,
    error: graphError,
    refetch: refetchGraph,
  } = useQuery({
    queryKey: ['graph', slug],
    queryFn: () => getGraph(slug),
    enabled: mode === 'concept',
  })

  const {
    data: relations,
    isLoading: isRelationsLoading,
    isError: isRelationsError,
    error: relationsError,
    refetch: refetchRelations,
  } = useQuery({
    queryKey: ['relations-graph', slug],
    queryFn: () => getRelationsGraph(slug),
    enabled: mode === 'entity',
  })

  const { data: labelsets } = useQuery({
    queryKey: ['labelsets', slug],
    queryFn: () => getLabelsets(slug),
  })

  const isConcept = mode === 'concept'
  const isLoading = isConcept ? isGraphLoading : isRelationsLoading
  const isError = isConcept ? isGraphError : isRelationsError
  const error = isConcept ? graphError : relationsError
  const refetch = isConcept ? refetchGraph : refetchRelations

  const isConceptEmpty = !graph || graph.nodes.length < 2 || graph.edges.length === 0
  const isEntityEmpty = !relations || relations.nodes.length < 2 || relations.edges.length === 0
  const isEmpty = isConcept ? isConceptEmpty : isEntityEmpty

  return (
    <main className='mx-auto max-w-6xl px-6 py-10'>
      <h1 className='text-2xl font-semibold tracking-tight text-ink'>Knowledge graph</h1>
      <p className='mt-1 text-sm text-ink-3'>
        {isConcept
          ? 'How the taxonomy categories co-occur across the indexed content.'
          : 'Entities extracted from the corpus and the relations between them.'}
      </p>

      <div className='mt-5'>
        <ModeToggle mode={mode} onChange={setMode} />
      </div>

      {isLoading && (
        <div className='mt-8'>
          <Skeleton className='h-[420px] w-full rounded-[calc(var(--rp-radius)+4px)]' />
        </div>
      )}

      {isError && (
        <div className='mt-8'>
          <ErrorCard
            message={error instanceof Error ? error.message : 'Could not load the graph.'}
            onRetry={() => void refetch()}
          />
        </div>
      )}

      {!isLoading && !isError && isEmpty && isConcept && (
        <div className='mt-8'>
          <EmptyState
            title='Not enough taxonomy yet'
            description='The graph needs at least two populated taxonomy categories to draw connections.'
          >
            <Link to={`/t/${slug}/taxonomy`} className='rp-btn rp-btn-primary'>
              Go to taxonomy
            </Link>
          </EmptyState>
        </div>
      )}

      {!isLoading && !isError && isEmpty && !isConcept && (
        <div className='mt-8'>
          <EmptyState
            title='No extracted relations yet'
            description="The knowledge graph agent may still be working through the corpus, or hasn't been set up yet - configure it from Manage."
          >
            <Link to='../manage' className='rp-btn rp-btn-primary'>
              Go to Manage
            </Link>
          </EmptyState>
        </div>
      )}

      {!isLoading && !isError && !isEmpty && isConcept && graph && (
        <ConceptGraph graph={graph} labelsets={labelsets} />
      )}

      {!isLoading && !isError && !isEmpty && !isConcept && relations && (
        <EntityGraph graph={relations} slug={slug} />
      )}
    </main>
  )
}
