import { type FormEvent, useCallback, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useOutletContext } from 'react-router-dom'
import type { KbCounters, ResourceSummary, TenantConfig } from '@research-portal/core'
import { getCounters, getResources } from '../api/client.ts'
import { EmptyState, ErrorCard, Skeleton, TypeBadge } from '../components/ui.tsx'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { TypeaheadDropdown, type TypeaheadItem, useTypeahead } from '../components/Typeahead.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

/* -------------------------------------------------------------------------
 * Hero
 * ---------------------------------------------------------------------- */

/**
 * The hero prompt. The tenant writes a search placeholder ("Search the grains
 * research library"); the portal asks rather than searches, so the leading verb
 * is swapped and the corpus flavour is kept.
 */
function askPlaceholder(searchPlaceholder: string): string {
  const trimmed = searchPlaceholder.trim()
  if (trimmed.length === 0) return 'Ask a question of this corpus'
  if (/^search\b/i.test(trimmed)) return trimmed.replace(/^search\b/i, 'Ask')
  return `Ask ${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`
}

/**
 * The hero backdrop. With a tenant hero photograph it is a full-bleed cover
 * image under a duotone wash of the tenant's hero colours; without one it is
 * the gradient, lifted by a radial bloom and a faint dot grid so it reads as a
 * designed surface rather than a flat colour field.
 */
function HeroBackdrop({ imageUrl }: { imageUrl?: string }) {
  const [imageFailed, setImageFailed] = useState(false)
  const showImage = Boolean(imageUrl) && !imageFailed

  return (
    <div className='absolute inset-0 -z-10 overflow-hidden' aria-hidden='true'>
      <div
        className='absolute inset-0'
        style={{ background: 'linear-gradient(135deg, var(--rp-hero-from), var(--rp-hero-to))' }}
      />
      {showImage && imageUrl
        ? (
          <>
            <img
              src={imageUrl}
              alt=''
              onError={() => setImageFailed(true)}
              className='rp-anim-kenburns absolute inset-0 h-full w-full object-cover'
            />
            <div className='rp-hero-duotone absolute inset-0' />
            <div className='rp-scrim-bottom absolute inset-0' />
          </>
        )
        : (
          <>
            <div className='rp-dotgrid absolute inset-0 opacity-70' />
            <div className='rp-hero-glow absolute inset-0' />
          </>
        )}
    </div>
  )
}

function Hero({
  config,
  onAsk,
  onSearch,
}: {
  config: TenantConfig
  /** The hero's own question path: submitting or picking a suggestion. */
  onAsk: (text: string) => void
  /** Resource-title picks only - those are a destination, not a question. */
  onSearch: (text: string) => void
}) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const suggested = config.suggestedQuestions.slice(0, 4)

  // An entity folds back into the question being written; a resource title is
  // a destination, so it goes straight to the results for that title.
  const onPick = useCallback((item: TypeaheadItem) => {
    if (item.kind === 'title') {
      onSearch(item.text)
      return
    }
    setQuery((prev) => `${prev.trim()} ${item.text} `.trimStart())
    inputRef.current?.focus()
  }, [onSearch])

  const typeahead = useTypeahead(config.slug, query, onPick)

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = query.trim()
    if (trimmed.length === 0) return
    typeahead.close()
    onAsk(trimmed)
  }

  return (
    <section className='relative isolate px-6 pb-24 pt-14 sm:pb-28 sm:pt-20'>
      <HeroBackdrop imageUrl={config.branding.heroImageUrl} />

      <div className='mx-auto max-w-3xl text-center'>
        <p className='rp-eyebrow rp-anim-rise text-white/70'>{config.branding.organisation}</p>

        <h1 className='rp-display rp-anim-rise rp-delay-1 mt-3 text-4xl text-white sm:text-5xl lg:text-6xl'>
          What would you like to explore?
        </h1>

        <p className='rp-anim-rise rp-delay-2 mx-auto mt-3 max-w-xl text-base leading-relaxed text-white/75'>
          {config.branding.tagline}
        </p>

        <form onSubmit={handleSubmit} className='rp-anim-rise rp-delay-3 mt-7' role='search'>
          <label htmlFor='explore-search' className='sr-only'>
            Ask {config.branding.productName}
          </label>
          <div ref={typeahead.wrapRef} className='relative mx-auto max-w-2xl'>
            <div className='rp-shadow-xl flex items-center gap-2 rounded-[10px] bg-surface p-1.5 pl-3.5 ring-1 ring-white/40 focus-within:ring-2 focus-within:ring-white'>
              <svg
                viewBox='0 0 20 20'
                fill='none'
                stroke='currentColor'
                strokeWidth='1.8'
                strokeLinecap='round'
                aria-hidden='true'
                className='h-5 w-5 shrink-0 text-ink-3'
              >
                <circle cx='9' cy='9' r='5.5' />
                <path d='M13.2 13.2L17 17' />
              </svg>
              <input
                id='explore-search'
                ref={inputRef}
                type='text'
                autoComplete='off'
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={typeahead.onKeyDown}
                placeholder={askPlaceholder(config.searchPlaceholder)}
                role='combobox'
                aria-autocomplete='list'
                aria-expanded={typeahead.open}
                aria-controls={typeahead.listboxId}
                aria-activedescendant={typeahead.activeDescendant}
                className='min-w-0 flex-1 border-0 bg-transparent px-2 py-2 text-[0.95rem] text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none'
              />
              <button type='submit' className='rp-btn rp-btn-primary shrink-0 font-semibold'>
                Ask
              </button>
            </div>
            <TypeaheadDropdown state={typeahead} />
          </div>
        </form>

        {suggested.length > 0
          ? (
            <div className='rp-anim-rise rp-delay-4 mt-5 flex flex-wrap justify-center gap-2'>
              {suggested.map((question) => (
                <button
                  key={question.id}
                  type='button'
                  onClick={() => onAsk(question.text)}
                  className='rp-focus-inverse rounded-[6px] bg-white/12 px-3 py-1.5 text-sm text-white ring-1 ring-inset ring-white/25 backdrop-blur-sm transition-colors duration-150 hover:bg-white/25'
                >
                  {question.text}
                </button>
              ))}
            </div>
          )
          : null}
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------
 * Stats
 * ---------------------------------------------------------------------- */

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className='rp-glass rp-shadow-md flex flex-col gap-0.5 rounded-[10px] border border-line px-4 py-3'>
      <span className='rp-display text-2xl text-ink'>{value}</span>
      <span className='rp-eyebrow text-ink-3'>{label}</span>
    </div>
  )
}

/** Floating glass tiles that overlap the hero's bottom edge. */
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
    <div className='rp-anim-rise rp-delay-4 relative z-10 mx-auto -mt-12 grid max-w-4xl grid-cols-2 gap-2.5 px-6 sm:grid-cols-4'>
      {stats.map((stat) => <StatTile key={stat.label} label={stat.label} value={stat.value} />)}
    </div>
  )
}

function StatsStripSkeleton() {
  return (
    <div className='relative z-10 mx-auto -mt-12 grid max-w-4xl grid-cols-2 gap-2.5 px-6 sm:grid-cols-4'>
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={index}
          className='rp-glass rp-shadow-md flex flex-col gap-2 rounded-[10px] border border-line px-4 py-4'
        >
          <Skeleton className='h-6 w-16' />
          <Skeleton className='h-2.5 w-20' />
        </div>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Topic rows
 * ---------------------------------------------------------------------- */

function ResourceCard({ slug, resource }: { slug: string; resource: ResourceSummary }) {
  return (
    <Link
      to={`/t/${slug}/library/${resource.id}`}
      className='rp-card rp-lift rp-focus group flex w-64 shrink-0 flex-col overflow-hidden sm:w-72'
    >
      <div className='relative aspect-[16/10] w-full overflow-hidden bg-surface-2'>
        <ResourceThumb
          slug={slug}
          id={resource.id}
          type={resource.type}
          className='rp-zoom'
        />
        <span className='absolute left-2 top-2'>
          <TypeBadge type={resource.type} />
        </span>
      </div>
      <div className='flex flex-1 flex-col gap-1.5 border-t border-line p-3.5'>
        <h3 className='rp-clamp-2 text-[0.9375rem] font-semibold leading-snug tracking-[-0.01em] text-ink'>
          {resource.title}
        </h3>
        <p className='rp-clamp-3 text-sm leading-relaxed text-ink-3'>{resource.summary}</p>
      </div>
    </Link>
  )
}

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className='flex items-center gap-2.5'>
      <h2 className='rp-display text-xl text-ink sm:text-[1.375rem]'>{label}</h2>
      <span className='rp-badge rp-badge-quiet tabular-nums'>{count}</span>
      <span className='h-px flex-1 bg-[var(--rp-line)]' aria-hidden='true' />
    </div>
  )
}

function TopicRowSkeleton() {
  return (
    <div>
      <Skeleton className='h-6 w-56' />
      <div className='mt-4 flex gap-3'>
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className='rp-card w-64 shrink-0 overflow-hidden sm:w-72'
          >
            <div className='rp-shimmer bg-surface-3 aspect-[16/10] w-full' aria-hidden='true' />
            <div className='space-y-2 border-t border-line p-3.5'>
              <Skeleton className='h-4 w-4/5' />
              <Skeleton className='h-3 w-full' />
              <Skeleton className='h-3 w-2/3' />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------- */

export function ExplorePage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const navigate = useNavigate()

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

  const {
    data: counters,
    isLoading: isCountersLoading,
    isError: isCountersError,
  } = useQuery({
    queryKey: ['counters', config.slug],
    queryFn: () => getCounters(config.slug),
  })

  const search = useCallback(
    (text: string) => navigate(`search?q=${encodeURIComponent(text)}`),
    [navigate],
  )

  // The hero asks rather than searches - Search no longer answers questions,
  // so a question the reader types (or picks from the suggestions) goes
  // straight to the assistant with the question pre-filled and auto-sent.
  const ask = useCallback(
    (text: string) => navigate(`/t/${config.slug}/assistant?ask=${encodeURIComponent(text)}`),
    [navigate, config.slug],
  )

  const hasRows = resourcesByTopic.size > 0

  return (
    <main>
      <Hero config={config} onAsk={ask} onSearch={search} />

      {isCountersLoading
        ? <StatsStripSkeleton />
        : !isCountersError && counters
        ? <StatsStrip counters={counters} />
        : null}

      <section className='mx-auto max-w-6xl space-y-10 px-6 pb-16 pt-12'>
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
            <>
              <TopicRowSkeleton />
              <TopicRowSkeleton />
            </>
          )
          : null}

        {!isLoading && !isError && !hasRows
          ? (
            <EmptyState
              title='Nothing to browse yet'
              description='This portal has no resources filed against its topics. Add content in the management screen, or run a corpus analysis to build the taxonomy.'
            >
              <Link to={`/t/${config.slug}/library`} className='rp-btn rp-btn-primary'>
                Open the library
              </Link>
            </EmptyState>
          )
          : null}

        {!isLoading && !isError
          ? config.topics.map((topic) => {
            const items = resourcesByTopic.get(topic.id)
            if (!items || items.length === 0) return null

            return (
              <div key={topic.id}>
                <SectionHeading label={topic.label} count={items.length} />
                <div className='rp-scroll-row rp-no-scrollbar -mx-6 mt-3.5 flex gap-3 overflow-x-auto px-6 pb-4 pt-1'>
                  {items.map((resource) => (
                    <ResourceCard key={resource.id} slug={config.slug} resource={resource} />
                  ))}
                </div>
              </div>
            )
          })
          : null}
      </section>
    </main>
  )
}
