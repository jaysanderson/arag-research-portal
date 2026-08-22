import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { Link, useOutletContext } from 'react-router-dom'
import type { CatalogItem } from '@research-portal/core'
import { getCatalog, getFacets, summarizeResources } from '../api/client.ts'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { EmptyState, ErrorCard, Skeleton } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

const PAGE_SIZE = 24

type SortValue = 'newest' | 'oldest' | 'title'

const SORT_VALUES: SortValue[] = ['newest', 'oldest', 'title']

const SORT_OPTIONS: Record<
  SortValue,
  { label: string; sort: 'created' | 'title'; order: 'asc' | 'desc' }
> = {
  newest: { label: 'Newest added', sort: 'created', order: 'desc' },
  oldest: { label: 'Oldest added', sort: 'created', order: 'asc' },
  title: { label: 'Title A-Z', sort: 'title', order: 'asc' },
}

const STATUS_BADGES: Record<'pending' | 'error', { label: string; className: string }> = {
  pending: { label: 'Processing', className: 'rp-badge rp-badge-warn' },
  error: { label: 'Error', className: 'rp-badge rp-badge-bad' },
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' })
}

function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <span
      aria-hidden='true'
      className='absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-[6px] border'
      style={selected
        ? { backgroundColor: 'var(--rp-accent)', borderColor: 'var(--rp-accent)' }
        : { backgroundColor: 'rgba(0, 0, 0, 0.28)', borderColor: 'rgba(255, 255, 255, 0.75)' }}
    >
      {selected
        ? (
          <svg
            viewBox='0 0 20 20'
            fill='none'
            stroke='#fff'
            strokeWidth='2.2'
            strokeLinecap='round'
            strokeLinejoin='round'
            className='h-3.5 w-3.5'
          >
            <path d='M4.5 10.5l3.5 3.5 7.5-8' />
          </svg>
        )
        : null}
    </span>
  )
}

function LibraryCard(
  { item, slug, topicLabel, selecting, selected, onToggleSelect }: {
    item: CatalogItem
    slug: string
    topicLabel: (id: string) => string | undefined
    selecting?: boolean
    selected?: boolean
    onToggleSelect?: (id: string) => void
  },
) {
  const topicLabels = item.topicIds
    .map((id) => topicLabel(id))
    .filter((label): label is string => Boolean(label))
  const statusInfo = item.status === 'processed' ? null : STATUS_BADGES[item.status]

  const body = (
    <>
      <div className='relative h-24 w-full overflow-hidden bg-surface-2' aria-hidden='true'>
        <ResourceThumb slug={slug} id={item.id} type='document' />
        {statusInfo
          ? (
            <span className={`absolute left-2 top-2 ${statusInfo.className}`}>
              {statusInfo.label}
            </span>
          )
          : null}
        {selecting ? <SelectionMark selected={Boolean(selected)} /> : null}
      </div>
      <div className='flex flex-1 flex-col gap-2 border-t border-line p-3.5'>
        <h3 className='rp-clamp-2 text-sm font-semibold leading-snug text-ink'>
          {item.title}
        </h3>
        {topicLabels.length > 0
          ? (
            <div className='flex flex-wrap gap-1'>
              {topicLabels.slice(0, 3).map((label) => (
                <span
                  key={label}
                  className='rounded-[4px] bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2'
                >
                  {label}
                </span>
              ))}
            </div>
          )
          : null}
        {item.created
          ? (
            <p className='mt-auto pt-1 text-xs tabular-nums text-ink-3'>
              {formatDate(item.created)}
            </p>
          )
          : null}
      </div>
    </>
  )

  if (selecting) {
    return (
      <button
        type='button'
        onClick={() => onToggleSelect?.(item.id)}
        aria-pressed={Boolean(selected)}
        className='rp-card rp-focus flex flex-col overflow-hidden text-left'
        style={selected
          ? { borderColor: 'var(--rp-accent)', boxShadow: '0 0 0 1px var(--rp-accent)' }
          : undefined}
      >
        {body}
      </button>
    )
  }

  return (
    <Link
      to={`/t/${slug}/library/${item.id}`}
      className='rp-card rp-lift rp-focus flex flex-col overflow-hidden'
    >
      {body}
    </Link>
  )
}

/**
 * Multi-document summary overlay - reading state, the synthesised summary,
 * the source titles it drew from, and a copy action. Mirrors the one on
 * SearchPage; kept as a local component since the two pages don't share a
 * components file.
 */
function SummaryModal({
  loading,
  error,
  summary,
  titles,
  onClose,
  onRetry,
}: {
  loading: boolean
  error: string | null
  summary: string
  titles: string[]
  onClose: () => void
  onRetry: () => void
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [])

  function copy() {
    navigator.clipboard.writeText(summary).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {
      // Clipboard access can be denied - the summary is still on screen to select by hand.
    })
  }

  return createPortal(
    <div
      className='rp-anim-fade fixed inset-0 z-[70] flex items-center justify-center bg-neutral-950/60 p-4 backdrop-blur-sm'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role='dialog'
        aria-modal='true'
        aria-label='Summary'
        className='rp-card rp-shadow-xl flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden'
      >
        <div className='flex shrink-0 items-center justify-between gap-3 border-b border-line px-5 py-3.5'>
          <h2 className='text-sm font-semibold text-ink'>Summary</h2>
          <button
            type='button'
            onClick={onClose}
            aria-label='Close'
            className='rp-btn rp-btn-ghost h-8 w-8 !px-0'
          >
            <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-3.5 w-3.5'>
              <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
            </svg>
          </button>
        </div>

        <div className='min-h-0 flex-1 overflow-y-auto px-5 py-4'>
          {loading
            ? (
              <div>
                <p className='text-sm text-ink-2'>
                  Reading {titles.length} {titles.length === 1 ? 'document' : 'documents'}…
                </p>
                <div className='mt-3 space-y-2' aria-hidden='true'>
                  <div className='rp-shimmer bg-surface-3 h-3.5 w-full rounded-[4px]' />
                  <div className='rp-shimmer bg-surface-3 h-3.5 w-full rounded-[4px]' />
                  <div className='rp-shimmer bg-surface-3 h-3.5 w-5/6 rounded-[4px]' />
                </div>
              </div>
            )
            : null}

          {!loading && error ? <ErrorCard message={error} onRetry={onRetry} /> : null}

          {!loading && !error
            ? <p className='whitespace-pre-wrap text-sm leading-relaxed text-ink-2'>{summary}</p>
            : null}
        </div>

        {!loading && !error
          ? (
            <div className='shrink-0 border-t border-line px-5 py-3.5'>
              <p className='rp-eyebrow text-ink-3'>Sources</p>
              <ul className='mt-1.5 max-h-24 space-y-0.5 overflow-y-auto text-xs text-ink-3'>
                {titles.map((title, index) => <li key={index} className='truncate'>{title}</li>)}
              </ul>
              <div className='mt-3 flex justify-end'>
                <button type='button' onClick={copy} className='rp-btn rp-btn-outline'>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )
          : null}
      </div>
    </div>,
    document.body,
  )
}

/** Hook wiring for the multi-document summary overlay. */
function useResourceSummary(slug: string) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState('')
  const [titles, setTitles] = useState<string[]>([])
  const lastRequest = useRef<{ ids: string[]; kind: 'simple' | 'extended' } | null>(null)

  const run = useCallback(
    (ids: string[], resourceTitles: string[], kind: 'simple' | 'extended' = 'simple') => {
      lastRequest.current = { ids, kind }
      setTitles(resourceTitles)
      setOpen(true)
      setLoading(true)
      setError(null)
      setSummary('')
      summarizeResources(slug, ids, kind)
        .then((res) => setSummary(res.summary))
        .catch((err) =>
          setError(err instanceof Error ? err.message : 'Could not generate a summary.')
        )
        .finally(() => setLoading(false))
    },
    [slug],
  )

  const retry = useCallback(() => {
    if (!lastRequest.current) return
    run(lastRequest.current.ids, titles, lastRequest.current.kind)
  }, [run, titles])

  return { open, loading, error, summary, titles, run, retry, close: () => setOpen(false) }
}

function LibraryCardSkeleton() {
  return (
    <div className='rp-card flex flex-col overflow-hidden'>
      <div className='rp-shimmer bg-surface-3 h-24 w-full' aria-hidden='true' />
      <div className='flex flex-col gap-2 border-t border-line p-3.5'>
        <Skeleton className='h-4 w-3/4' />
        <Skeleton className='h-4 w-1/2' />
        <Skeleton className='h-3 w-24' />
      </div>
    </div>
  )
}

export function LibraryPage() {
  const { config } = useOutletContext<TenantOutletContext>()

  const [queryDraft, setQueryDraft] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [sort, setSort] = useState<SortValue>('newest')
  const [selectedTopics, setSelectedTopics] = useState<string[]>([])
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [page, setPage] = useState(0)
  const [accumulated, setAccumulated] = useState<CatalogItem[]>([])
  const [total, setTotal] = useState(0)
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(queryDraft.trim()), 300)
    return () => clearTimeout(timer)
  }, [queryDraft])

  const topicsKey = selectedTopics.join(',')

  useEffect(() => {
    setPage(0)
    setAccumulated([])
    setTotal(0)
    setSelectedIds(new Set())
  }, [debouncedQuery, sort, topicsKey])

  const summaryModal = useResourceSummary(config.slug)

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exitSelection() {
    setSelecting(false)
    setSelectedIds(new Set())
  }

  function summariseSelected() {
    if (selectedIds.size < 2 || selectedIds.size > 20) return
    const chosen = accumulated.filter((item) => selectedIds.has(item.id))
    summaryModal.run(
      chosen.map((item) => item.id),
      chosen.map((item) => item.title),
      selectedIds.size > 5 ? 'extended' : 'simple',
    )
  }

  const sortOption = SORT_OPTIONS[sort]

  const { data: facets } = useQuery({
    queryKey: ['facets', config.slug],
    queryFn: () => getFacets(config.slug, ['topic']),
  })
  const topicCounts = facets?.topic ?? {}

  const {
    data,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['catalog', config.slug, debouncedQuery, sort, topicsKey, page],
    queryFn: () =>
      getCatalog(config.slug, {
        page,
        pageSize: PAGE_SIZE,
        query: debouncedQuery || undefined,
        topicIds: selectedTopics,
        sort: sortOption.sort,
        order: sortOption.order,
      }),
  })

  useEffect(() => {
    if (!data) return
    setAccumulated((prev) => (page === 0 ? data.items : [...prev, ...data.items]))
    setTotal(data.total)
  }, [data, page])

  const topicLabel = useMemo(() => {
    const map = new Map(config.topics.map((topic) => [topic.id, topic.label]))
    return (id: string) => map.get(id)
  }, [config.topics])

  function toggleTopic(id: string) {
    setSelectedTopics((prev) =>
      prev.includes(id) ? prev.filter((topicId) => topicId !== id) : [...prev, id]
    )
  }

  const hasMore = accumulated.length < total
  const isInitialLoading = isLoading && page === 0

  return (
    <main className='mx-auto max-w-6xl px-6 py-8'>
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h1 className='rp-display text-2xl text-ink'>Library</h1>
        {!isInitialLoading && !isError
          ? (
            <p className='text-sm font-medium tabular-nums text-ink-3'>
              {total.toLocaleString()} {total === 1 ? 'resource' : 'resources'}
            </p>
          )
          : null}
      </div>

      <div className='mt-4 flex flex-wrap items-center gap-2'>
        <div className='flex min-w-[16rem] flex-1 items-center gap-2 rounded-[6px] border border-line bg-surface px-3 py-1.5'>
          <label htmlFor='library-search' className='sr-only'>
            Search the library
          </label>
          <svg
            viewBox='0 0 20 20'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.8'
            strokeLinecap='round'
            aria-hidden='true'
            className='h-4 w-4 shrink-0 text-ink-3'
          >
            <circle cx='9' cy='9' r='5.5' />
            <path d='M13.2 13.2L17 17' />
          </svg>
          <input
            id='library-search'
            type='text'
            autoComplete='off'
            value={queryDraft}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQueryDraft(event.target.value)}
            placeholder='Search within the library'
            className='min-w-0 flex-1 border-0 bg-transparent py-1 text-sm text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none'
          />
        </div>

        <label htmlFor='library-sort' className='sr-only'>
          Sort by
        </label>
        <select
          id='library-sort'
          value={sort}
          onChange={(event) => setSort(event.target.value as SortValue)}
          className='rp-focus rounded-[6px] border border-line bg-surface px-3 py-2 text-sm text-ink'
        >
          {SORT_VALUES.map((value) => (
            <option key={value} value={value}>
              {SORT_OPTIONS[value].label}
            </option>
          ))}
        </select>

        {config.topics.length > 0
          ? (
            <button
              type='button'
              onClick={() => setFiltersOpen((open) => !open)}
              className='rp-chip h-9 sm:h-7 lg:hidden'
              aria-expanded={filtersOpen}
            >
              Filters{selectedTopics.length > 0 ? ` (${selectedTopics.length})` : ''}
            </button>
          )
          : null}

        {accumulated.length > 0
          ? (
            <button
              type='button'
              onClick={() => selecting ? exitSelection() : setSelecting(true)}
              aria-pressed={selecting}
              className='rp-chip h-9 sm:h-7'
            >
              {selecting ? 'Done selecting' : 'Select'}
            </button>
          )
          : null}
      </div>

      <div className='mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[230px_1fr]'>
        {config.topics.length > 0
          ? (
            <aside className={`${filtersOpen ? 'block' : 'hidden'} lg:block`}>
              <div className='rp-card p-4 lg:sticky lg:top-20'>
                <div className='flex items-center justify-between gap-2'>
                  <p className='rp-eyebrow text-ink-3'>Topics</p>
                  {selectedTopics.length > 0
                    ? (
                      <button
                        type='button'
                        onClick={() => setSelectedTopics([])}
                        className='text-xs font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
                      >
                        Clear
                      </button>
                    )
                    : null}
                </div>
                <div className='mt-2.5 space-y-0.5'>
                  {config.topics.map((topic) => {
                    const count = topicCounts[topic.id] ?? 0
                    const checked = selectedTopics.includes(topic.id)
                    const muted = count === 0 && !checked
                    return (
                      <label
                        key={topic.id}
                        className={`flex cursor-pointer items-center gap-2.5 rounded-[6px] px-1 py-1 text-sm ${
                          muted ? 'text-ink-3' : 'text-ink-2'
                        }`}
                      >
                        <input
                          type='checkbox'
                          checked={checked}
                          onChange={() => toggleTopic(topic.id)}
                          className='h-4 w-4 shrink-0 rounded-[3px] border-line'
                          style={{ accentColor: 'var(--rp-accent)' }}
                        />
                        <span className='min-w-0 flex-1'>{topic.label}</span>
                        <span className='text-xs tabular-nums text-ink-3'>{count}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            </aside>
          )
          : null}

        <div className='min-w-0'>
          {isError
            ? (
              <ErrorCard
                message={error instanceof Error ? error.message : 'Could not load the library.'}
                onRetry={() => void refetch()}
              />
            )
            : null}

          {isInitialLoading
            ? (
              <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'>
                {Array.from({ length: 6 }).map((_, index) => <LibraryCardSkeleton key={index} />)}
              </div>
            )
            : null}

          {!isInitialLoading && !isError && accumulated.length === 0
            ? (
              <EmptyState
                title='No resources match these filters'
                description='Try a different search term, or clear the topic filters.'
              />
            )
            : null}

          {!isInitialLoading && !isError && accumulated.length > 0
            ? (
              <>
                <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'>
                  {accumulated.map((item) => (
                    <LibraryCard
                      key={item.id}
                      item={item}
                      slug={config.slug}
                      topicLabel={topicLabel}
                      selecting={selecting}
                      selected={selectedIds.has(item.id)}
                      onToggleSelect={toggleSelect}
                    />
                  ))}
                </div>

                {hasMore
                  ? (
                    <div className='mt-6 flex justify-center'>
                      <button
                        type='button'
                        onClick={() => setPage((prev) => prev + 1)}
                        disabled={isFetching}
                        className='rp-btn rp-btn-outline'
                      >
                        {isFetching ? 'Loading…' : 'Load more'}
                      </button>
                    </div>
                  )
                  : null}
              </>
            )
            : null}
        </div>
      </div>

      {selecting
        ? (
          <div
            role='region'
            aria-label='Selection actions'
            className='fixed inset-x-0 bottom-4 z-40 flex justify-center px-4'
          >
            <div className='rp-shadow-lg flex items-center gap-3 rounded-[10px] border border-line bg-surface px-4 py-2.5'>
              <span className='text-sm font-medium tabular-nums text-ink'>
                {selectedIds.size} selected
              </span>
              <button
                type='button'
                onClick={summariseSelected}
                disabled={selectedIds.size < 2 || selectedIds.size > 20}
                className='rp-btn rp-btn-primary'
              >
                Summarise
              </button>
              <button type='button' onClick={exitSelection} className='rp-btn rp-btn-ghost'>
                Cancel
              </button>
            </div>
          </div>
        )
        : null}

      {summaryModal.open
        ? (
          <SummaryModal
            loading={summaryModal.loading}
            error={summaryModal.error}
            summary={summaryModal.summary}
            titles={summaryModal.titles}
            onClose={summaryModal.close}
            onRetry={summaryModal.retry}
          />
        )
        : null}
    </main>
  )
}
