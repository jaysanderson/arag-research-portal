import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useOutletContext } from 'react-router-dom'
import type { KbCounters, Question, ResourceSummary, TenantConfig } from '@research-portal/core'
import { getCounters, getFacets, getTopicResources } from '../api/client.ts'
import { topicsWithFacetCounts } from '../lib/topic-rows.ts'
import { prettyLabel } from '../components/ui.tsx'
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
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    setReduced(query.matches)
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return reduced
}

const SUGGESTED_WINDOW = 4
const SUGGESTED_ROTATE_MS = 8000

/**
 * The hero's suggested-question chips, rotating a window of four through the
 * tenant's full list every ~8 seconds with a gentle crossfade. Rotation pauses
 * on hover/focus of the group, on pointerover of a chip (so a click never has
 * its target swapped out from under it), and entirely under
 * prefers-reduced-motion. The chips stay clickable throughout - pausing never
 * disables them, it only stops the timer.
 */
function SuggestedQuestions({
  questions,
  onAsk,
}: {
  questions: Question[]
  onAsk: (text: string) => void
}) {
  const [start, setStart] = useState(0)
  const [paused, setPaused] = useState(false)
  const reducedMotion = usePrefersReducedMotion()
  const rotates = questions.length > SUGGESTED_WINDOW

  useEffect(() => {
    if (!rotates || paused || reducedMotion) return
    const timer = setInterval(() => {
      setStart((prev) => (prev + SUGGESTED_WINDOW) % questions.length)
    }, SUGGESTED_ROTATE_MS)
    return () => clearInterval(timer)
  }, [rotates, paused, reducedMotion, questions.length])

  const visible = useMemo(() => {
    if (!rotates) return questions
    return Array.from(
      { length: SUGGESTED_WINDOW },
      (_, index) => questions[(start + index) % questions.length],
    ).filter((question): question is Question => Boolean(question))
  }, [questions, rotates, start])

  if (visible.length === 0) return null

  const pause = () => setPaused(true)
  const resume = () => setPaused(false)

  return (
    <div
      className='rp-anim-rise rp-delay-4 mt-5'
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume()
      }}
    >
      <div key={start} className='rp-anim-fade flex flex-wrap justify-center gap-2'>
        {visible.map((question) => (
          <button
            key={question.id}
            type='button'
            onClick={() => onAsk(question.text)}
            onPointerOver={pause}
            className='rp-focus-inverse rounded-[6px] bg-white/12 px-3 py-1.5 text-sm text-white ring-1 ring-inset ring-white/25 backdrop-blur-sm transition-colors duration-150 hover:bg-white/25'
          >
            {question.text}
          </button>
        ))}
      </div>
    </div>
  )
}

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

        <SuggestedQuestions questions={config.suggestedQuestions} onAsk={onAsk} />
      </div>
    </section>
  )
}

/* -------------------------------------------------------------------------
 * Stats
 * ---------------------------------------------------------------------- */

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className='rp-shadow-md flex flex-col gap-0.5 rounded-[10px] border border-line bg-surface px-4 py-3'>
      <span className='rp-display text-2xl text-ink'>{value}</span>
      <span className='rp-eyebrow text-ink-3'>{label}</span>
    </div>
  )
}

/** Floating glass tiles that overlap the hero's bottom edge. */
/**
 * Coverage statement: what KINDS of content the hub holds, so a researcher
 * knows the boundaries before investing time - counts alone say nothing.
 */
function CoverageStrip({ slug, organisation }: { slug: string; organisation: string }) {
  const { data } = useQuery({
    queryKey: ['coverage', slug],
    queryFn: () => getFacets(slug, ['kind']),
    staleTime: 5 * 60 * 1000,
  })
  const kinds = Object.entries(data?.kind ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
  if (kinds.length === 0) return null
  return (
    <p className='mx-auto mt-4 max-w-5xl px-6 text-center text-sm text-ink-2'>
      Holding {kinds.map(([label, count], index) => (
        <span key={label}>
          {index > 0 ? (index === kinds.length - 1 ? ' and ' : ', ') : ''}
          <span className='font-medium text-ink'>
            {count} {((l) => (count === 1 || l.endsWith('s') ? l : `${l}s`))(
              prettyLabel(label, organisation).toLowerCase(),
            )}
          </span>
        </span>
      ))}.
    </p>
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
    <div className='rp-anim-rise rp-delay-4 relative z-10 mx-auto -mt-12 grid max-w-5xl grid-cols-2 gap-2.5 px-6 sm:grid-cols-4'>
      {stats.map((stat) => <StatTile key={stat.label} label={stat.label} value={stat.value} />)}
    </div>
  )
}

function StatsStripSkeleton() {
  return (
    <div className='relative z-10 mx-auto -mt-12 grid max-w-5xl grid-cols-2 gap-2.5 px-6 sm:grid-cols-4'>
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
        {resource.summary && resource.summary !== resource.title
          ? <p className='rp-clamp-3 text-sm leading-relaxed text-ink-3'>{resource.summary}</p>
          : null}
        {resource.sourceName
          ? (
            <p className='mt-auto truncate pt-1 text-[11px] tabular-nums text-ink-3/80'>
              {resource.sourceName}
            </p>
          )
          : null}
      </div>
    </Link>
  )
}

function SectionHeading(
  { slug, topicId, label, count }: { slug: string; topicId: string; label: string; count: number },
) {
  return (
    <div className='flex items-center gap-2.5'>
      <h2 className='rp-display text-xl text-ink sm:text-[1.375rem]'>{label}</h2>
      <span className='rp-badge rp-badge-quiet tabular-nums'>{count}</span>
      <span className='h-px flex-1 bg-[var(--rp-line)]' aria-hidden='true' />
      <Link
        to={`/t/${slug}/library?topic=${encodeURIComponent(topicId)}`}
        className='rp-focus shrink-0 rounded-[4px] text-sm font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
      >
        See all<span aria-hidden='true'>&rarr;</span>
      </Link>
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

/** Resources shown per topic row - a horizontal scroll row's worth. */
const TOPIC_ROW_LIMIT = 12

/* -------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------- */

export function ExplorePage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const navigate = useNavigate()

  // The box's real classification index, not per-resource topicIds (the DA
  // classifier's labels don't reliably land in a listed resource's own
  // usermetadata - see the provider's `topicResources` doc comment). Facet
  // counts say which topics are non-empty; each non-empty topic's row is
  // then fetched from the same index via `topicResources`.
  const {
    data: facets,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['topic-facets', config.slug],
    queryFn: () => getFacets(config.slug, ['topic']),
  })

  const nonEmptyTopics = useMemo(
    () => topicsWithFacetCounts(config.topics, facets ?? {}),
    [facets, config.topics],
  )

  const topicRowQueries = useQueries({
    queries: nonEmptyTopics.map(({ topic }) => ({
      queryKey: ['topic-resources', config.slug, topic.id],
      queryFn: () => getTopicResources(config.slug, topic.id, TOPIC_ROW_LIMIT),
      staleTime: 5 * 60 * 1000,
    })),
  })

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

  // Genuinely empty only when the box's classification index has zero topic
  // facets - never because a per-resource topicIds field came back empty.
  const hasRows = nonEmptyTopics.length > 0

  return (
    <main>
      <Hero config={config} onAsk={ask} onSearch={search} />

      {isCountersLoading
        ? <StatsStripSkeleton />
        : !isCountersError && counters
        ? <StatsStrip counters={counters} />
        : null}
      <CoverageStrip slug={config.slug} organisation={config.branding.organisation} />

      <section className='rp-shell space-y-10 pb-16 pt-12'>
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
          ? nonEmptyTopics.map(({ topic, count }, index) => {
            const rowQuery = topicRowQueries[index]
            if (rowQuery?.isLoading) return <TopicRowSkeleton key={topic.id} />
            // A row's own fetch failing, or resolving empty (e.g. every
            // matching resource is hidden/junk), quietly drops that one row
            // rather than mislabelling the whole portal empty.
            const items = rowQuery?.data
            if (!items || items.length === 0) return null

            return (
              <div key={topic.id}>
                <SectionHeading
                  slug={config.slug}
                  topicId={topic.id}
                  label={topic.label}
                  count={count}
                />
                <div className='rp-scroll-row rp-no-scrollbar -mx-6 mt-3.5 flex gap-3 overflow-x-auto px-6 pb-4 pt-1 lg:-mx-8 lg:px-8 2xl:-mx-10 2xl:px-10'>
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
