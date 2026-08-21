import { type FormEvent, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext, useParams } from 'react-router-dom'
import { ApiError, getResource } from '../api/client.ts'
import { AnswerStream } from '../components/AnswerStream.tsx'
import { ErrorCard, Skeleton, TypeBadge } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' })
}

function DetailSkeleton() {
  return (
    <div className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
      <div className='flex items-center justify-between'>
        <Skeleton className='h-5 w-16' />
        <Skeleton className='h-4 w-24' />
      </div>
      <Skeleton className='mt-4 h-7 w-3/4' />
      <Skeleton className='mt-3 h-4 w-full' />
      <Skeleton className='mt-1 h-4 w-5/6' />
      <Skeleton className='mt-1 h-4 w-2/3' />
    </div>
  )
}

export function ResourceDetailPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const { id } = useParams<{ id: string }>()

  const [askDraft, setAskDraft] = useState('')
  const [askQuery, setAskQuery] = useState('')

  const {
    data: resource,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['resource', config.slug, id],
    queryFn: () => getResource(config.slug, id ?? ''),
    enabled: Boolean(id),
    retry: (failureCount, err) =>
      !(err instanceof ApiError && err.status === 404) && failureCount < 1,
  })

  const notFound = error instanceof ApiError && error.status === 404

  function handleAskSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = askDraft.trim()
    if (trimmed.length === 0) return
    setAskQuery(trimmed)
  }

  const topicLabel = (topicId: string) => config.topics.find((topic) => topic.id === topicId)?.label

  return (
    <main className='mx-auto max-w-3xl px-6 py-10'>
      <Link
        to={`/t/${config.slug}/library`}
        className='text-sm font-medium text-neutral-500 transition-colors duration-150 hover:text-neutral-900'
      >
        &larr; Back to library
      </Link>

      <div className='mt-6'>
        {isLoading ? <DetailSkeleton /> : null}

        {isError && notFound
          ? (
            <div className='rounded-2xl border border-dashed border-neutral-300 bg-white/60 p-8 text-center'>
              <p className='text-sm font-medium text-neutral-900'>This document does not exist</p>
              <p className='mt-1 text-sm text-neutral-500'>
                It may have been removed, or the link is out of date.
              </p>
              <Link
                to={`/t/${config.slug}/library`}
                className='mt-4 inline-flex items-center rounded-full px-4 py-2 text-sm font-medium text-white transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
                style={{ backgroundColor: 'var(--rp-primary)', outlineColor: 'var(--rp-accent)' }}
              >
                Back to library
              </Link>
            </div>
          )
          : null}

        {isError && !notFound
          ? (
            <ErrorCard
              message={error instanceof Error ? error.message : 'Could not load this document.'}
              onRetry={() => void refetch()}
            />
          )
          : null}

        {!isLoading && !isError && resource
          ? (
            <>
              <article className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
                <div className='flex flex-wrap items-center justify-between gap-3'>
                  <TypeBadge type={resource.type} />
                  {resource.published
                    ? (
                      <span className='text-xs font-medium text-neutral-400'>
                        Published {formatDate(resource.published)}
                      </span>
                    )
                    : null}
                </div>

                <h1 className='mt-3 text-2xl font-semibold tracking-tight text-neutral-900'>
                  {resource.title}
                </h1>
                <p className='mt-2 text-sm leading-relaxed text-neutral-600'>{resource.summary}</p>

                {resource.topicIds.length > 0
                  ? (
                    <div className='mt-4 flex flex-wrap gap-1.5'>
                      {resource.topicIds.map((topicId) => {
                        const label = topicLabel(topicId)
                        if (!label) return null
                        return (
                          <span
                            key={topicId}
                            className='inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs text-neutral-600'
                          >
                            {label}
                          </span>
                        )
                      })}
                    </div>
                  )
                  : null}

                {resource.keyFacts.length > 0
                  ? (
                    <div className='mt-6'>
                      <p className='text-xs font-semibold uppercase tracking-wide text-neutral-500'>
                        Key facts
                      </p>
                      <ol className='mt-2 space-y-1.5'>
                        {resource.keyFacts.map((fact, index) => (
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

              <section className='mt-8 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
                <h2 className='text-xs font-semibold uppercase tracking-wide text-neutral-500'>
                  Ask this document
                </h2>
                <form onSubmit={handleAskSubmit} className='mt-3'>
                  <label htmlFor='ask-document' className='sr-only'>
                    Ask a question about {resource.title}
                  </label>
                  <div className='flex items-center gap-2 rounded-full border border-neutral-200 bg-white p-2'>
                    <input
                      id='ask-document'
                      type='text'
                      value={askDraft}
                      onChange={(event) => setAskDraft(event.target.value)}
                      placeholder='Ask a question about this document'
                      className='min-w-0 flex-1 rounded-full border-0 bg-transparent px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none'
                    />
                    <button
                      type='submit'
                      className='shrink-0 rounded-full px-4 py-2 text-sm font-semibold text-white transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
                      style={{
                        backgroundColor: 'var(--rp-primary)',
                        outlineColor: 'var(--rp-accent)',
                      }}
                    >
                      Ask
                    </button>
                  </div>
                </form>

                {askQuery.trim().length > 0
                  ? (
                    <div className='mt-4'>
                      <AnswerStream
                        slug={config.slug}
                        request={{ query: askQuery, resourceId: resource.id }}
                      />
                    </div>
                  )
                  : null}
              </section>
            </>
          )
          : null}
      </div>
    </main>
  )
}
