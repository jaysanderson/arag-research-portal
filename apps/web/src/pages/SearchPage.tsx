import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import type { RetrievalMode, ScoredResource } from '@research-portal/core'
import {
  addWatch,
  deleteWatch,
  getFacets,
  listWatches,
  markWatchSeen,
  type SavedWatch,
  searchTenantFull,
  summarizeResources,
} from '../api/client.ts'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { TypeaheadDropdown, type TypeaheadItem, useTypeahead } from '../components/Typeahead.tsx'
import { EmptyState, ErrorCard, Skeleton, TypeBadge } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

const MODES: { value: RetrievalMode; label: string }[] = [
  { value: 'hybrid', label: 'Hybrid' },
  { value: 'semantic', label: 'Semantic' },
  { value: 'keyword', label: 'Keyword' },
]

function RelevanceMeter({ relevance }: { relevance: number }) {
  const percent = Math.round(relevance * 100)

  return (
    <div className='flex shrink-0 items-center gap-2'>
      <div
        className='h-1 w-20 overflow-hidden rounded-[2px] bg-surface-3'
        role='progressbar'
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label='Relevance'
      >
        <div
          className='h-full'
          style={{ width: `${percent}%`, backgroundColor: 'var(--rp-accent)' }}
        />
      </div>
      <span className='text-xs font-medium tabular-nums text-ink-3'>{percent}%</span>
    </div>
  )
}

/**
 * One result. The matched passage is the point of the card - it is the citation
 * in context, which is why this view needs no synthesised answer above it.
 */
function ResultCard({ resource, slug }: { resource: ScoredResource; slug: string }) {
  const keyFacts = resource.keyFacts.slice(0, 3)

  return (
    <article id={`result-${resource.id}`} className='rp-card scroll-mt-6 p-4 sm:p-5'>
      <div className='flex gap-4'>
        <div className='hidden h-16 w-24 shrink-0 overflow-hidden rounded-[6px] border border-line sm:block'>
          <ResourceThumb slug={slug} id={resource.id} type={resource.type} />
        </div>

        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-center justify-between gap-2'>
            <TypeBadge type={resource.type} />
            <RelevanceMeter relevance={resource.relevance} />
          </div>

          <h3 className='mt-2.5 text-base font-semibold tracking-[-0.01em] text-ink'>
            <Link to={`/t/${slug}/library/${resource.id}`} className='rp-focus rounded-[4px]'>
              {resource.title}
            </Link>
          </h3>
          <p className='mt-1.5 text-sm leading-relaxed text-ink-2'>{resource.summary}</p>

          {resource.matchedPassage
            ? (
              <blockquote
                className='mt-3 border-l-2 bg-surface-2 py-2 pl-3 pr-2 text-sm italic leading-relaxed text-ink-2'
                style={{ borderColor: 'var(--rp-accent)' }}
              >
                &ldquo;{resource.matchedPassage}&rdquo;
              </blockquote>
            )
            : null}

          {keyFacts.length > 0
            ? (
              <div className='mt-3.5'>
                <p className='rp-eyebrow text-ink-3'>Key facts</p>
                <ol className='mt-1.5 space-y-1'>
                  {keyFacts.map((fact, index) => (
                    <li key={index} className='flex gap-2 text-sm text-ink-2'>
                      <span className='font-medium tabular-nums text-ink-3'>{index + 1}.</span>
                      <span>{fact}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )
            : null}
        </div>
      </div>
    </article>
  )
}

function ResultCardSkeleton() {
  return (
    <div className='rp-card p-4 sm:p-5'>
      <div className='flex items-center justify-between'>
        <Skeleton className='h-5 w-16' />
        <Skeleton className='h-4 w-24' />
      </div>
      <Skeleton className='mt-3.5 h-5 w-3/4' />
      <Skeleton className='mt-2 h-4 w-full' />
      <Skeleton className='mt-1 h-4 w-5/6' />
    </div>
  )
}

/**
 * Multi-document summary overlay - reading state, the synthesised summary,
 * the source titles it drew from, and a copy action. Shared shape with the
 * one on LibraryPage; kept as a local component since the two pages don't
 * share a components file.
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
  const dialogRef = useRef<HTMLDivElement | null>(null)

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

  // Move focus into the dialog on open, and give it back to whatever
  // triggered it once the dialog closes.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    return () => {
      previouslyFocused?.focus()
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
        ref={dialogRef}
        tabIndex={-1}
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

/** Hook wiring for the multi-document summary overlay - shared by any caller with a resource list. */
function useResourceSummary(slug: string) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState('')
  const [titles, setTitles] = useState<string[]>([])
  const lastRequest = useRef<{ ids: string[]; kind: 'simple' | 'extended' } | null>(null)
  // A slower earlier request must never overwrite a newer one.
  const requestSeq = useRef(0)

  const run = useCallback(
    (ids: string[], resourceTitles: string[], kind: 'simple' | 'extended' = 'simple') => {
      lastRequest.current = { ids, kind }
      const requestId = ++requestSeq.current
      setTitles(resourceTitles)
      setOpen(true)
      setLoading(true)
      setError(null)
      setSummary('')
      summarizeResources(slug, ids, kind)
        .then((res) => {
          if (requestId !== requestSeq.current) return
          setSummary(res.summary)
        })
        .catch((err) => {
          if (requestId !== requestSeq.current) return
          setError(err instanceof Error ? err.message : 'Could not generate a summary.')
        })
        .finally(() => {
          if (requestId !== requestSeq.current) return
          setLoading(false)
        })
    },
    [slug],
  )

  const retry = useCallback(() => {
    if (!lastRequest.current) return
    run(lastRequest.current.ids, titles, lastRequest.current.kind)
  }, [run, titles])

  return { open, loading, error, summary, titles, run, retry, close: () => setOpen(false) }
}

/** Quiet strip of saved searches - each chip re-runs the search and shows a changed dot when new results have arrived. */
function WatchStrip(
  { watches, onRun, onDelete }: {
    watches: SavedWatch[]
    onRun: (watch: SavedWatch) => void
    onDelete: (id: string) => void
  },
) {
  if (watches.length === 0) return null

  return (
    <div className='mb-4 flex flex-wrap items-center gap-1.5'>
      <span className='rp-eyebrow shrink-0 text-ink-3'>Saved</span>
      {watches.map((watch) => (
        <div
          key={watch.id}
          className='inline-flex items-center gap-0.5 rounded-[6px] border border-line bg-surface py-0.5 pl-1 pr-0.5'
        >
          <button
            type='button'
            onClick={() => onRun(watch)}
            className='rp-focus flex items-center gap-1.5 rounded-[3px] px-1.5 py-1 text-xs text-ink-2 transition-colors duration-150 hover:text-[var(--rp-ink)]'
          >
            {watch.changed
              ? (
                <>
                  <span
                    role='status'
                    className='h-1.5 w-1.5 shrink-0 rounded-full'
                    style={{ backgroundColor: 'var(--rp-accent)' }}
                    aria-label='New results'
                  />
                  <span className='sr-only'>has new results</span>
                </>
              )
              : null}
            <span className='max-w-[12rem] truncate'>{watch.query}</span>
          </button>
          <button
            type='button'
            onClick={(event) => {
              event.stopPropagation()
              onDelete(watch.id)
            }}
            aria-label={`Remove saved search "${watch.query}"`}
            className='rp-focus flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px] text-ink-3 transition-colors duration-150 hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
          >
            <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-3 w-3'>
              <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
            </svg>
          </button>
        </div>
      ))}
    </div>
  )
}

export function SearchPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get('q') ?? ''
  const mode: RetrievalMode = (() => {
    const raw = searchParams.get('mode')
    return raw === 'semantic' || raw === 'keyword' ? raw : 'hybrid'
  })()
  const selectedTopics = useMemo(() => {
    const raw = searchParams.get('topics')
    return raw ? raw.split(',').filter((id) => id.length > 0) : []
  }, [searchParams])

  const [draft, setDraft] = useState(q)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setDraft(q)
  }, [q])

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value.length === 0) next.delete(key)
          else next.set(key, value)
        }
        return next
      })
    },
    [setSearchParams],
  )

  function toggleTopic(id: string) {
    const set = new Set(selectedTopics)
    if (set.has(id)) set.delete(id)
    else set.add(id)
    updateParams({ topics: Array.from(set).join(',') || null })
  }

  // Entities sharpen the query in place; a resource title is a search of its own.
  const onPick = useCallback((item: TypeaheadItem) => {
    if (item.kind === 'title') {
      setDraft(item.text)
      updateParams({ q: item.text })
      return
    }
    setDraft((prev) => `${prev.trim()} ${item.text} `.trimStart())
    inputRef.current?.focus()
  }, [updateParams])

  const typeahead = useTypeahead(config.slug, draft, onPick)

  const { data: facets } = useQuery({
    queryKey: ['facets', config.slug],
    queryFn: () => getFacets(config.slug, ['topic']),
  })
  const topicCounts = facets?.topic ?? {}

  const {
    data: results,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['search', config.slug, q, mode, selectedTopics.join(',')],
    queryFn: () => searchTenantFull(config.slug, q, { mode, topicIds: selectedTopics }),
    enabled: q.trim().length > 0,
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    typeahead.close()
    updateParams({ q: trimmed })
  }

  function askQuestion(text: string) {
    setDraft(text)
    updateParams({ q: text })
  }

  const hasQuery = q.trim().length > 0
  const trimmedQuery = q.trim()

  const queryClient = useQueryClient()
  const { data: watches } = useQuery({
    queryKey: ['watches', config.slug],
    queryFn: () => listWatches(config.slug),
  })
  const invalidateWatches = () =>
    queryClient.invalidateQueries({ queryKey: ['watches', config.slug] })
  const addWatchMutation = useMutation({
    mutationFn: () => addWatch(config.slug, trimmedQuery),
    onSuccess: invalidateWatches,
  })
  const deleteWatchMutation = useMutation({
    mutationFn: (id: string) => deleteWatch(config.slug, id),
    onSuccess: invalidateWatches,
  })
  const markSeenMutation = useMutation({
    mutationFn: (id: string) => markWatchSeen(config.slug, id),
    onSuccess: invalidateWatches,
  })
  const isWatchingCurrent = hasQuery &&
    (watches ?? []).some((watch) => watch.query.trim() === trimmedQuery)

  function runWatch(watch: SavedWatch) {
    setDraft(watch.query)
    updateParams({ q: watch.query })
    markSeenMutation.mutate(watch.id)
  }

  const summaryModal = useResourceSummary(config.slug)

  function summariseResults() {
    if (!results || results.resources.length === 0) return
    const top = results.resources.slice(0, 10)
    summaryModal.run(top.map((r) => r.id), top.map((r) => r.title))
  }

  return (
    <main className='mx-auto max-w-6xl px-6 py-8'>
      <div className='flex flex-wrap items-baseline justify-between gap-3'>
        <h1 className='rp-display text-2xl text-ink'>Search</h1>
        <Link
          to={`/t/${config.slug}`}
          className='text-sm font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
        >
          &larr; Back to explore
        </Link>
      </div>

      <form onSubmit={handleSubmit} className='mt-4' role='search'>
        <label htmlFor='search-input' className='sr-only'>
          Search {config.branding.productName}
        </label>
        <div ref={typeahead.wrapRef} className='relative'>
          <div className='rp-shadow-sm flex items-center gap-2 rounded-[8px] border border-line bg-surface p-1.5 pl-3'>
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
              id='search-input'
              ref={inputRef}
              type='text'
              autoComplete='off'
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={typeahead.onKeyDown}
              placeholder={config.searchPlaceholder}
              role='combobox'
              aria-autocomplete='list'
              aria-expanded={typeahead.open}
              aria-controls={typeahead.listboxId}
              aria-activedescendant={typeahead.activeDescendant}
              className='min-w-0 flex-1 border-0 bg-transparent px-1.5 py-1.5 text-sm text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none'
            />
            <button type='submit' className='rp-btn rp-btn-primary shrink-0 font-semibold'>
              Search
            </button>
          </div>
          <TypeaheadDropdown state={typeahead} />
        </div>
      </form>

      <p className='mt-2 text-xs text-ink-3'>
        Looking for a synthesised answer?{' '}
        <Link
          to='../assistant'
          className='font-medium underline decoration-dotted underline-offset-2'
          style={{ color: 'var(--rp-accent)' }}
        >
          Ask the Assistant
        </Link>
      </p>

      <div className='mt-4 flex flex-wrap items-center gap-2.5'>
        <div
          className='inline-flex overflow-hidden rounded-[6px] border border-line bg-surface'
          role='radiogroup'
          aria-label='Retrieval mode'
        >
          {MODES.map((option, index) => {
            const active = mode === option.value
            return (
              <button
                key={option.value}
                type='button'
                role='radio'
                aria-checked={active}
                onClick={() =>
                  updateParams({ mode: option.value === 'hybrid' ? null : option.value })}
                className={`rp-focus px-3.5 py-1.5 text-xs font-medium transition-colors duration-150 ${
                  index > 0 ? 'border-l border-line' : ''
                } ${
                  active
                    ? 'text-white'
                    : 'text-[var(--rp-ink-2)] hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
                }`}
                style={active ? { backgroundColor: 'var(--rp-primary)' } : undefined}
              >
                {option.label}
              </button>
            )
          })}
        </div>

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

        {hasQuery
          ? (
            isWatchingCurrent ? <span className='rp-badge rp-badge-quiet'>Watching</span> : (
              <button
                type='button'
                onClick={() => addWatchMutation.mutate()}
                disabled={addWatchMutation.isPending}
                className='rp-chip h-9 sm:h-7'
              >
                {addWatchMutation.isPending ? 'Saving…' : 'Watch this search'}
              </button>
            )
          )
          : null}

        {hasQuery && !isLoading && !isError && results
          ? (
            <p className='ml-auto text-sm font-medium tabular-nums text-ink-3'>
              {results.resources.length} {results.resources.length === 1 ? 'resource' : 'resources'}
            </p>
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
                        onClick={() => updateParams({ topics: null })}
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
          <WatchStrip
            watches={watches ?? []}
            onRun={runWatch}
            onDelete={(id) => deleteWatchMutation.mutate(id)}
          />

          {!hasQuery
            ? (
              <div className='rp-card p-5'>
                <p className='rp-eyebrow text-ink-3'>Start here</p>
                <p className='mt-2 text-base font-semibold text-ink'>
                  Search {config.branding.productName}
                </p>
                <p className='mt-1 text-sm leading-relaxed text-ink-2'>
                  Results carry the passage that matched, so you can judge a source before you open
                  it.
                </p>
                {config.suggestedQuestions.length > 0
                  ? (
                    <div className='mt-4 flex flex-wrap gap-1.5'>
                      {config.suggestedQuestions.slice(0, 6).map((question) => (
                        <button
                          key={question.id}
                          type='button'
                          onClick={() => askQuestion(question.text)}
                          className='rp-chip h-9 sm:h-7'
                        >
                          {question.text}
                        </button>
                      ))}
                    </div>
                  )
                  : null}
              </div>
            )
            : null}

          {hasQuery && isLoading
            ? (
              <div className='space-y-3'>
                <ResultCardSkeleton />
                <ResultCardSkeleton />
                <ResultCardSkeleton />
              </div>
            )
            : null}

          {hasQuery && isError
            ? (
              <ErrorCard
                message={error instanceof Error ? error.message : 'Could not run this search.'}
                onRetry={() => void refetch()}
              />
            )
            : null}

          {hasQuery && !isLoading && !isError && results
            ? (
              <>
                {results.resources.length === 0
                  ? (
                    <EmptyState
                      title='No resources matched that search'
                      description='Try broader terms, a different retrieval mode, or fewer topic filters.'
                    />
                  )
                  : (
                    <>
                      <div className='flex justify-end'>
                        <button
                          type='button'
                          onClick={summariseResults}
                          className='text-xs font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
                        >
                          Summarise these results
                        </button>
                      </div>
                      <div className='mt-2 space-y-3'>
                        {results.resources.map((resource) => (
                          <ResultCard key={resource.id} resource={resource} slug={config.slug} />
                        ))}
                      </div>
                    </>
                  )}

                {results.relatedQuestions.length > 0
                  ? (
                    <div className='mt-8'>
                      <p className='rp-eyebrow text-ink-3'>People also ask</p>
                      <div className='mt-2.5 flex flex-col gap-1.5'>
                        {results.relatedQuestions.map((question) => (
                          <button
                            key={question.id}
                            type='button'
                            onClick={() => askQuestion(question.text)}
                            className='rp-focus flex items-center justify-between gap-3 rounded-[6px] border border-line bg-[var(--rp-surface)] px-3.5 py-2.5 text-left text-sm text-[var(--rp-ink-2)] transition-colors duration-150 hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
                          >
                            <span>{question.text}</span>
                            <span aria-hidden='true' className='shrink-0 text-ink-3'>&rarr;</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                  : null}
              </>
            )
            : null}
        </div>
      </div>

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
