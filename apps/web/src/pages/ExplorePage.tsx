import { type FormEvent, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useOutletContext } from 'react-router-dom'
import type { KbCounters, ResourceSummary } from '@research-portal/core'
import { getCounters, getResources } from '../api/client.ts'
import { ErrorCard, hueFromId, Skeleton, TypeBadge } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

function ResourceCard({ resource }: { resource: ResourceSummary }) {
  const hue = hueFromId(resource.id)

  return (
    <div className='flex w-64 shrink-0 flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm transition-shadow duration-150 hover:shadow-md'>
      <div
        className='h-32 w-full'
        style={{ backgroundColor: `hsl(${hue}, 45%, 88%)` }}
        aria-hidden='true'
      />
      <div className='flex flex-1 flex-col gap-2 p-4'>
        <TypeBadge type={resource.type} />
        <h3 className='rp-clamp-2 text-sm font-semibold leading-snug text-neutral-900'>
          {resource.title}
        </h3>
        <p className='rp-clamp-3 text-sm leading-relaxed text-neutral-500'>{resource.summary}</p>
      </div>
    </div>
  )
}

function HeroSkeleton() {
  return (
    <div className='mx-auto flex max-w-xl flex-wrap justify-center gap-2'>
      <Skeleton className='h-8 w-40 rounded-full' />
      <Skeleton className='h-8 w-48 rounded-full' />
      <Skeleton className='h-8 w-36 rounded-full' />
      <Skeleton className='h-8 w-44 rounded-full' />
    </div>
  )
}

function StatsStripSkeleton() {
  return (
    <div className='mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-6 py-6'>
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className='flex flex-col items-center gap-1.5'>
          <Skeleton className='h-6 w-14' />
          <Skeleton className='h-3 w-20' />
        </div>
      ))}
    </div>
  )
}

function StatsStrip({ counters }: { counters: KbCounters }) {
  const stats = [
    { label: 'Resources', value: counters.resources.toLocaleString() },
    { label: 'Paragraphs', value: counters.paragraphs.toLocaleString() },
    { label: 'Sentences', value: counters.sentences.toLocaleString() },
    {
      label: 'Index MB',
      value: counters.indexMb.toLocaleString(undefined, { maximumFractionDigits: 1 }),
    },
  ]

  return (
    <div className='mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-6 py-6 text-center'>
      {stats.map((stat) => (
        <div key={stat.label} className='flex flex-col items-center'>
          <span className='text-xl font-semibold tracking-tight text-neutral-900'>
            {stat.value}
          </span>
          <span className='text-xs font-medium uppercase tracking-wide text-neutral-500'>
            {stat.label}
          </span>
        </div>
      ))}
    </div>
  )
}

function TopicRowSkeleton() {
  return (
    <div className='mx-auto max-w-6xl px-6'>
      <Skeleton className='h-5 w-56' />
      <div className='mt-4 flex gap-4'>
        <Skeleton className='h-48 w-64 shrink-0 rounded-2xl' />
        <Skeleton className='h-48 w-64 shrink-0 rounded-2xl' />
        <Skeleton className='h-48 w-64 shrink-0 rounded-2xl' />
      </div>
    </div>
  )
}

export function ExplorePage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')

  const {
    data: resources,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['resources', config.slug],
    queryFn: () => getResources(config.slug),
  })

  const resourcesByTopic = useMemo(() => {
    const map = new Map<string, ResourceSummary[]>()
    if (!resources) return map
    for (const topic of config.topics) {
      const matches = resources.filter((resource) => resource.topicIds.includes(topic.id))
      if (matches.length > 0) {
        map.set(topic.id, matches)
      }
    }
    return map
  }, [resources, config.topics])

  const suggested = config.suggestedQuestions.slice(0, 4)

  const {
    data: counters,
    isLoading: isCountersLoading,
    isError: isCountersError,
  } = useQuery({
    queryKey: ['counters', config.slug],
    queryFn: () => getCounters(config.slug),
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = query.trim()
    if (trimmed.length === 0) return
    navigate(`search?q=${encodeURIComponent(trimmed)}`)
  }

  return (
    <main>
      <section
        className='px-6 py-20 sm:py-28'
        style={{
          background: 'linear-gradient(135deg, var(--rp-hero-from), var(--rp-hero-to))',
        }}
      >
        <div className='mx-auto max-w-2xl text-center'>
          <h1 className='text-3xl font-semibold tracking-tight text-white sm:text-4xl'>
            What would you like to explore?
          </h1>

          <form onSubmit={handleSubmit} className='mt-8' role='search'>
            <label htmlFor='explore-search' className='sr-only'>
              Search {config.branding.productName}
            </label>
            <div className='flex items-center gap-2 rounded-full bg-white p-2 shadow-lg'>
              <input
                id='explore-search'
                type='search'
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={config.searchPlaceholder}
                className='min-w-0 flex-1 rounded-full border-0 bg-transparent px-4 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none'
              />
              <button
                type='submit'
                className='shrink-0 rounded-full px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white'
                style={{ backgroundColor: 'var(--rp-primary)' }}
              >
                Search
              </button>
            </div>
          </form>

          {isLoading
            ? (
              <div className='mt-6'>
                <HeroSkeleton />
              </div>
            )
            : suggested.length > 0
            ? (
              <div className='mt-6 flex flex-wrap justify-center gap-2'>
                {suggested.map((question) => (
                  <button
                    key={question.id}
                    type='button'
                    onClick={() => navigate(`search?q=${encodeURIComponent(question.text)}`)}
                    className='rounded-full bg-white/15 px-4 py-2 text-sm text-white ring-1 ring-inset ring-white/30 transition-colors duration-150 hover:bg-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white'
                  >
                    {question.text}
                  </button>
                ))}
              </div>
            )
            : null}
        </div>
      </section>

      {isCountersLoading ? <StatsStripSkeleton /> : null}
      {!isCountersLoading && !isCountersError && counters
        ? <StatsStrip counters={counters} />
        : null}

      <section className='mx-auto max-w-6xl space-y-10 px-6 py-12'>
        {isError
          ? (
            <ErrorCard
              message={error instanceof Error ? error.message : 'Could not load resources.'}
              onRetry={() => void refetch()}
            />
          )
          : null}

        {isLoading
          ? (
            <div className='space-y-10'>
              <TopicRowSkeleton />
              <TopicRowSkeleton />
            </div>
          )
          : null}

        {!isLoading && !isError
          ? config.topics.map((topic) => {
            const items = resourcesByTopic.get(topic.id)
            if (!items || items.length === 0) return null

            return (
              <div key={topic.id}>
                <h2 className='text-lg font-semibold tracking-tight text-neutral-900'>
                  {topic.label}
                </h2>
                <div className='rp-scroll-row mt-4 flex gap-4 overflow-x-auto pb-2'>
                  {items.map((resource) => <ResourceCard key={resource.id} resource={resource} />)}
                </div>
              </div>
            )
          })
          : null}
      </section>
    </main>
  )
}
