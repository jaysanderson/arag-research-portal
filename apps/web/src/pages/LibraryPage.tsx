import { type ChangeEvent, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext } from 'react-router-dom'
import type { CatalogItem } from '@research-portal/core'
import { getCatalog, getFacets } from '../api/client.ts'
import { EmptyState, ErrorCard, hueFromId, Skeleton } from '../components/ui.tsx'
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

const STATUS_STYLES: Record<'pending' | 'error', { label: string; className: string }> = {
  pending: { label: 'Processing', className: 'bg-amber-50 text-amber-700 ring-amber-200' },
  error: { label: 'Error', className: 'bg-rose-50 text-rose-700 ring-rose-200' },
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
  const hue = hueFromId(item.id)
  const topicLabels = item.topicIds
    .map((id) => topicLabel(id))
    .filter((label): label is string => Boolean(label))
  const statusInfo = item.status === 'processed' ? null : STATUS_STYLES[item.status]

  return (
    <Link
      to={`/t/${slug}/library/${item.id}`}
      className='flex flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm transition-shadow duration-150 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
      style={{ outlineColor: 'var(--rp-accent)' }}
    >
      <div
        className='h-28 w-full'
        style={{ backgroundColor: `hsl(${hue}, 45%, 88%)` }}
        aria-hidden='true'
      />
      <div className='flex flex-1 flex-col gap-2 p-4'>
        {statusInfo
          ? (
            <span
              className={`inline-flex w-fit items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${statusInfo.className}`}
            >
              {statusInfo.label}
            </span>
          )
          : null}
        <h3 className='rp-clamp-2 text-sm font-semibold leading-snug text-neutral-900'>
          {item.title}
        </h3>
        {topicLabels.length > 0
          ? (
            <div className='flex flex-wrap gap-1.5'>
              {topicLabels.map((label) => (
                <span
                  key={label}
                  className='inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600'
                >
                  {label}
                </span>
              ))}
            </div>
          )
          : null}
        {item.created
          ? <p className='mt-auto pt-1 text-xs text-neutral-400'>{formatDate(item.created)}</p>
          : null}
      </div>
    </Link>
  )
}

function LibraryCardSkeleton() {
  return (
    <div className='flex flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm'>
      <Skeleton className='h-28 w-full rounded-none' />
      <div className='flex flex-col gap-2 p-4'>
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
    <main className='mx-auto max-w-6xl px-6 py-10'>
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <h1 className='text-2xl font-semibold tracking-tight text-neutral-900'>Library</h1>
        {!isInitialLoading && !isError
          ? (
            <p className='text-sm font-medium text-neutral-500'>
              {total.toLocaleString()} {total === 1 ? 'resource' : 'resources'}
            </p>
          )
          : null}
      </div>

      <div className='mt-6 flex flex-wrap items-center gap-3'>
        <div className='flex min-w-[16rem] flex-1 items-center gap-2 rounded-full border border-neutral-200 bg-white px-4 py-2.5 shadow-sm'>
          <label htmlFor='library-search' className='sr-only'>
            Search the library
          </label>
          <input
            id='library-search'
            type='search'
            value={queryDraft}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setQueryDraft(event.target.value)}
            placeholder='Search within the library'
            className='min-w-0 flex-1 border-0 bg-transparent text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none'
          />
        </div>

        <label htmlFor='library-sort' className='sr-only'>
          Sort by
        </label>
        <select
          id='library-sort'
          value={sort}
          onChange={(event) => setSort(event.target.value as SortValue)}
          className='rounded-full border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-700 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
          style={{ outlineColor: 'var(--rp-accent)' }}
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
              className='inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-3.5 py-2 text-xs font-medium text-neutral-600 transition-colors duration-150 hover:text-neutral-900 lg:hidden'
            >
              Filters{selectedTopics.length > 0 ? ` (${selectedTopics.length})` : ''}
            </button>
          )
          : null}
      </div>

      <div className='mt-8 grid grid-cols-1 gap-8 lg:grid-cols-[220px_1fr]'>
        {config.topics.length > 0
          ? (
            <aside className={`${filtersOpen ? 'block' : 'hidden'} lg:block`}>
              <h2 className='text-xs font-semibold uppercase tracking-wide text-neutral-500'>
                Topics
              </h2>
              <div className='mt-3 space-y-2'>
                {config.topics.map((topic) => {
                  const count = topicCounts[topic.id] ?? 0
                  const checked = selectedTopics.includes(topic.id)
                  return (
                    <label
                      key={topic.id}
                      className={`flex items-center gap-2 text-sm ${
                        count === 0 && !checked ? 'text-neutral-300' : 'text-neutral-700'
                      }`}
                    >
                      <input
                        type='checkbox'
                        checked={checked}
                        onChange={() => toggleTopic(topic.id)}
                        className='rounded border-neutral-300'
                        style={{ accentColor: 'var(--rp-accent)' }}
                      />
                      <span className='flex-1'>{topic.label}</span>
                      <span className='text-xs text-neutral-400'>{count}</span>
                    </label>
                  )
                })}
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
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
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
                <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
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
                    <div className='mt-8 flex justify-center'>
                      <button
                        type='button'
                        onClick={() => setPage((prev) => prev + 1)}
                        disabled={isFetching}
                        className='inline-flex items-center rounded-full border border-neutral-200 bg-white px-5 py-2.5 text-sm font-medium text-neutral-700 shadow-sm transition-colors duration-150 hover:border-neutral-300 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
                        style={{ outlineColor: 'var(--rp-accent)' }}
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
