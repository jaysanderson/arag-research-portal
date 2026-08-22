import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext } from 'react-router-dom'
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from 'd3-force'
import type { GraphData, Labelset } from '@research-portal/core'
import { getGraph, getLabelsets } from '../api/client.ts'
import { EmptyState, ErrorCard, Skeleton } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

const WIDTH = 900
const HEIGHT = 600

// ---------------------------------------------------------------------------
// Force layout - run the simulation for a fixed number of ticks up front,
// then render the settled positions as plain SVG. No animation loop, so
// nothing to clean up and nothing that can jank.
// ---------------------------------------------------------------------------

type SimNode = {
  id: string
  label: string
  group: 'primary' | 'secondary'
  weight: number
  x?: number
  y?: number
  vx?: number
  vy?: number
  index?: number
}

type SimLink = {
  source: string
  target: string
  weight: number
}

type Position = { x: number; y: number }

function radiusFor(weight: number): number {
  return Math.max(6, Math.min(26, Math.sqrt(weight) * 3 + 6))
}

function layout(graph: GraphData): Map<string, Position> {
  const positions = new Map<string, Position>()
  if (graph.nodes.length === 0) return positions

  const simNodes: SimNode[] = graph.nodes.map((n) => ({ ...n }))
  const simLinks: SimLink[] = graph.edges.map((e) => ({
    source: e.source,
    target: e.target,
    weight: e.weight,
  }))

  const simulation = forceSimulation<SimNode>(simNodes)
    .force('charge', forceManyBody().strength(-140))
    .force(
      'link',
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.id)
        .distance(80)
        .strength(0.35),
    )
    .force('center', forceCenter(WIDTH / 2, HEIGHT / 2))
    .force(
      'collide',
      forceCollide<SimNode>().radius((d) => radiusFor(d.weight) + 6),
    )
    .stop()

  for (let i = 0; i < 150; i++) simulation.tick()

  for (const n of simNodes) {
    positions.set(n.id, { x: n.x ?? WIDTH / 2, y: n.y ?? HEIGHT / 2 })
  }
  return positions
}

// ---------------------------------------------------------------------------
// Side panel - the selected node's neighbours and co-occurrence weights.
// ---------------------------------------------------------------------------

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
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-5 shadow-sm'>
      <div className='flex items-start justify-between gap-2'>
        <div>
          <p className='text-xs font-semibold uppercase tracking-wide text-ink-3'>Selected</p>
          <h2 className='mt-0.5 text-base font-semibold tracking-tight text-ink'>
            {node?.label ?? selectedId}
          </h2>
        </div>
        <button
          type='button'
          onClick={onClear}
          className='rp-btn rp-btn-ghost h-auto shrink-0 px-2.5 py-1 text-xs'
        >
          Clear
        </button>
      </div>

      <p className='mt-3 text-xs font-semibold uppercase tracking-wide text-ink-3'>
        Connections ({connections.length})
      </p>
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
    </div>
  )
}

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

/**
 * Knowledge graph - taxonomy co-occurrence between the tenant's primary and
 * secondary labelsets, laid out with d3-force and rendered as static SVG.
 */
export function GraphPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const slug = config.slug

  const {
    data: graph,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['graph', slug],
    queryFn: () => getGraph(slug),
  })

  const { data: labelsets } = useQuery({
    queryKey: ['labelsets', slug],
    queryFn: () => getLabelsets(slug),
  })

  const [positions, setPositions] = useState<Map<string, Position>>(new Map())
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    setSelectedId(null)
    if (graph) {
      setPositions(layout(graph))
    } else {
      setPositions(new Map())
    }
  }, [graph])

  const labelsetTitle = (id: string | undefined): string => {
    const found: Labelset | undefined = labelsets?.find((l) => l.id === id)
    return found?.title ?? id ?? 'Category'
  }

  const maxWeight = useMemo(
    () => graph?.nodes.reduce((max, n) => Math.max(max, n.weight), 1) ?? 1,
    [graph],
  )
  const maxEdgeWeight = useMemo(
    () => graph?.edges.reduce((max, e) => Math.max(max, e.weight), 1) ?? 1,
    [graph],
  )

  const neighbourIds = useMemo(() => {
    if (!graph || !selectedId) return new Set<string>()
    const ids = new Set<string>()
    for (const e of graph.edges) {
      if (e.source === selectedId) ids.add(e.target)
      if (e.target === selectedId) ids.add(e.source)
    }
    return ids
  }, [graph, selectedId])

  const isEmpty = !graph || graph.nodes.length < 2 || graph.edges.length === 0

  return (
    <main className='mx-auto max-w-6xl px-6 py-10'>
      <h1 className='text-2xl font-semibold tracking-tight text-ink'>Knowledge graph</h1>
      <p className='mt-1 text-sm text-ink-3'>
        How the taxonomy categories co-occur across the indexed content.
      </p>

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

      {!isLoading && !isError && isEmpty && (
        <div className='mt-8'>
          <EmptyState
            title='Not enough taxonomy yet'
            description='The graph needs at least two populated taxonomy categories to draw connections.'
          >
            <Link
              to={`/t/${slug}/taxonomy`}
              className='rp-btn rp-btn-primary'
            >
              Go to taxonomy
            </Link>
          </EmptyState>
        </div>
      )}

      {!isLoading && !isError && graph && !isEmpty && (
        <div className='mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_320px]'>
          <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-4 shadow-sm'>
            <div className='overflow-x-auto'>
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
                        stroke={touchesSelected ? 'var(--rp-accent)' : 'var(--rp-line)'}
                        strokeWidth={Math.max(1, (e.weight / maxEdgeWeight) * 4)}
                        strokeOpacity={dimmed ? 0.08 : Math.max(0.2, e.weight / maxEdgeWeight)}
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
                    return (
                      <g
                        key={n.id}
                        opacity={dimmed ? 0.2 : 1}
                        onClick={(event) => {
                          event.stopPropagation()
                          setSelectedId(n.id)
                        }}
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
                            fontSize={11}
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
      )}
    </main>
  )
}
