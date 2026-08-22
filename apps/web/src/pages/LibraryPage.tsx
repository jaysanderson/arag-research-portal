import { type ChangeEvent, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext } from 'react-router-dom'
import type { CatalogItem } from '@research-portal/core'
import { getCatalog, getFacets } from '../api/client.ts'
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

function LibraryCard(
  { item, slug, topicLabel }: {
    item: CatalogItem
    slug: string
    topicLabel: (id: string) => string | undefined
  },
) {
  const topicLabels = item.topicIds
    .map((id) => topicLabel(id))
    .filter((label): label is string => Boolean(label))
  const statusInfo = item.status === 'processed' ? null : STATUS_BADGES[item.status]

  return (
    <Link
      to={`/t/${slug}/library/${item.id}`}
      className='rp-card rp-lift rp-focus flex flex-col overflow-hidden'
    >
      <div className='relative h-24 w-full overflow-hidden bg-surface-2' aria-hidden='true'>
        <ResourceThumb slug={slug} id={item.id} type='document' />
        {statusInfo
          ? (
            <span className={`absolute left-2 top-2 ${statusInfo.className}`}>
              {statusInfo.label}
            </span>
          )
          : null}
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
    </Link>
  )
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

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(queryDraft.trim()), 300)
    return () => clearTimeout(timer)
  }, [queryDraft])

  const topicsKey = selectedTopics.join(',')

  useEffect(() => {
    setPage(0)
    setAccumulated([])
    setTotal(0)
  }, [debouncedQuery, sort, topicsKey])

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
              className='rp-chip lg:hidden'
              aria-expanded={filtersOpen}
            >
              Filters{selectedTopics.length > 0 ? ` (${selectedTopics.length})` : ''}
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
    </main>
  )
}
