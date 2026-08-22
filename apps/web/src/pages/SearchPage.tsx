import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import type { RetrievalMode, ScoredResource } from '@research-portal/core'
import { getFacets, searchTenantFull } from '../api/client.ts'
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
              className='rp-chip lg:hidden'
              aria-expanded={filtersOpen}
            >
              Filters{selectedTopics.length > 0 ? ` (${selectedTopics.length})` : ''}
            </button>
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
                          className='rp-chip'
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
                    <div className='space-y-3'>
                      {results.resources.map((resource) => (
                        <ResultCard key={resource.id} resource={resource} slug={config.slug} />
                      ))}
                    </div>
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
    </main>
  )
}
