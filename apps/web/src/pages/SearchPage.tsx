import { type FormEvent, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import type { ScoredResource } from '@research-portal/core'
import { searchTenant } from '../api/client.ts'
import { EmptyState, ErrorCard, Skeleton, TypeBadge } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

function RelevanceMeter({ relevance }: { relevance: number }) {
  const percent = Math.round(relevance * 100)

  return (
    <div className='flex items-center gap-2'>
      <div
        className='h-1.5 w-24 overflow-hidden rounded-full bg-neutral-200'
        role='progressbar'
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label='Relevance'
      >
        <div
          className='h-full rounded-full'
          style={{ width: `${percent}%`, backgroundColor: 'var(--rp-accent)' }}
        />
      </div>
      <span className='text-xs font-medium text-neutral-500'>{percent}% relevant</span>
    </div>
  )
}

function ResultCard({ resource }: { resource: ScoredResource }) {
  const keyFacts = resource.keyFacts.slice(0, 3)

  return (
    <article className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <TypeBadge type={resource.type} />
        <RelevanceMeter relevance={resource.relevance} />
      </div>

      <h3 className='mt-3 text-lg font-semibold tracking-tight text-neutral-900'>
        {resource.title}
      </h3>
      <p className='mt-2 text-sm leading-relaxed text-neutral-600'>{resource.summary}</p>

      {resource.matchedPassage
        ? (
          <blockquote
            className='mt-4 border-l-2 pl-4 text-sm italic leading-relaxed text-neutral-600'
            style={{ borderColor: 'var(--rp-accent)' }}
          >
            &ldquo;{resource.matchedPassage}&rdquo;
          </blockquote>
        )
        : null}

      {keyFacts.length > 0
        ? (
          <div className='mt-4'>
            <p className='text-xs font-semibold uppercase tracking-wide text-neutral-500'>
              Key facts
            </p>
            <ol className='mt-2 space-y-1'>
              {keyFacts.map((fact, index) => (
                <li key={index} className='flex gap-2 text-sm text-neutral-700'>
                  <span className='font-medium text-neutral-400'>{index + 1}.</span>
                  <span>{fact}</span>
                </li>
              ))}
            </ol>
          </div>
        )
        : null}
    </article>
  )
}

function ResultCardSkeleton() {
  return (
    <div className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
      <div className='flex items-center justify-between'>
        <Skeleton className='h-5 w-16' />
        <Skeleton className='h-5 w-28' />
      </div>
      <Skeleton className='mt-4 h-5 w-3/4' />
      <Skeleton className='mt-2 h-4 w-full' />
      <Skeleton className='mt-1 h-4 w-5/6' />
    </div>
  )
}

export function SearchPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get('q') ?? ''
  const [draft, setDraft] = useState(q)

  const {
    data: results,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['search', config.slug, q],
    queryFn: () => searchTenant(config.slug, q),
    enabled: q.trim().length > 0,
  })

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    setSearchParams({ q: trimmed })
  }

  function askQuestion(text: string) {
    setDraft(text)
    setSearchParams({ q: text })
  }

  return (
    <main className='mx-auto max-w-4xl px-6 py-10'>
      <Link
        to={`/t/${config.slug}`}
        className='text-sm font-medium text-neutral-500 transition-colors duration-150 hover:text-neutral-900'
      >
        &larr; Back to explore
      </Link>

      <form onSubmit={handleSubmit} className='mt-4' role='search'>
        <label htmlFor='search-input' className='sr-only'>
          Search {config.branding.productName}
        </label>
        <div className='flex items-center gap-2 rounded-full border border-neutral-200 bg-white p-2 shadow-sm'>
          <input
            id='search-input'
            type='search'
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={config.searchPlaceholder}
            className='min-w-0 flex-1 rounded-full border-0 bg-transparent px-4 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none'
          />
          <button
            type='submit'
            className='shrink-0 rounded-full px-5 py-2.5 text-sm font-semibold text-white transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
            style={{ backgroundColor: 'var(--rp-primary)', outlineColor: 'var(--rp-accent)' }}
          >
            Search
          </button>
        </div>
      </form>

      <div className='mt-8'>
        {q.trim().length === 0
          ? (
            <div className='py-12 text-center'>
              <p className='text-lg font-medium text-neutral-900'>
                Type a question to search {config.branding.productName}
              </p>
              <p className='mt-1 text-sm text-neutral-500'>
                Or try one of these to get started.
              </p>
              {config.suggestedQuestions.length > 0
                ? (
                  <div className='mt-6 flex flex-wrap justify-center gap-2'>
                    {config.suggestedQuestions.slice(0, 6).map((question) => (
                      <button
                        key={question.id}
                        type='button'
                        onClick={() => askQuestion(question.text)}
                        className='rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-700 transition-colors duration-150 hover:border-neutral-300 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
                        style={{ outlineColor: 'var(--rp-accent)' }}
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

        {q.trim().length > 0 && isLoading
          ? (
            <div className='space-y-4'>
              <ResultCardSkeleton />
              <ResultCardSkeleton />
              <ResultCardSkeleton />
            </div>
          )
          : null}

        {q.trim().length > 0 && isError
          ? (
            <ErrorCard
              message={error instanceof Error ? error.message : 'Could not run this search.'}
              onRetry={() => void refetch()}
            />
          )
          : null}

        {q.trim().length > 0 && !isLoading && !isError && results
          ? (
            <>
              <p className='text-sm font-medium text-neutral-500'>
                {results.resources.length}{' '}
                {results.resources.length === 1 ? 'resource' : 'resources'}
              </p>

              {results.resources.length === 0
                ? (
                  <div className='mt-4'>
                    <EmptyState
                      title='No resources matched that search'
                      description='Try broader terms, or ask a different question.'
                    />
                  </div>
                )
                : (
                  <div className='mt-4 space-y-4'>
                    {results.resources.map((resource) => (
                      <ResultCard key={resource.id} resource={resource} />
                    ))}
                  </div>
                )}

              {results.relatedQuestions.length > 0
                ? (
                  <div className='mt-10'>
                    <h2 className='text-sm font-semibold uppercase tracking-wide text-neutral-500'>
                      People also ask
                    </h2>
                    <div className='mt-3 flex flex-col gap-2'>
                      {results.relatedQuestions.map((question) => (
                        <button
                          key={question.id}
                          type='button'
                          onClick={() => askQuestion(question.text)}
                          className='rounded-xl border border-neutral-200 bg-white px-4 py-3 text-left text-sm text-neutral-700 transition-colors duration-150 hover:border-neutral-300 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
                          style={{ outlineColor: 'var(--rp-accent)' }}
                        >
                          {question.text}
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
    </main>
  )
}
