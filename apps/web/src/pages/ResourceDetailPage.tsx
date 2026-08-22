import { type FormEvent, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import type { ResourceContent } from '@research-portal/core'
import { ApiError, getResource, getResourceContent, resourceFileUrl } from '../api/client.ts'
import { AnswerStream } from '../components/AnswerStream.tsx'
import { ErrorCard, Skeleton, TypeBadge } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' })
}

/** Lowercase + collapse whitespace, so passage matching survives punctuation/whitespace drift. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** The matchable fragment of a `?passage=` value: normalised, first 40 characters. */
function passageNeedle(passage: string | null): string | null {
  if (!passage) return null
  const normalised = normalise(passage)
  return normalised.length > 0 ? normalised.slice(0, 40) : null
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const mm = Math.floor(total / 60)
  const ss = total % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

/** Split a resource's extracted-text fields into paragraphs, joined across fields. */
function useJoinedParagraphs(texts: { fieldId: string; text: string }[]): string[] {
  return useMemo(() => {
    const joined = texts.map((field) => field.text).join('\n\n')
    return joined
      .split(/\n+/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => paragraph.length > 0)
  }, [texts])
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

function BodySkeleton() {
  return (
    <div className='mt-8 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
      <Skeleton className='h-72 w-full' />
    </div>
  )
}

/**
 * Extracted-text paragraphs with optional passage highlighting. Shared by the
 * web, PDF, text and file bodies. `passage` drives a one-time scroll-into-view
 * of the matching paragraph on mount, so a citation link lands the reader on
 * the exact cited passage.
 */
function ExtractedTextPanel(
  { paragraphs, passage }: { paragraphs: string[]; passage: string | null },
) {
  const highlightRef = useRef<HTMLParagraphElement | null>(null)
  const needle = passageNeedle(passage)
  const highlightIndex = needle
    ? paragraphs.findIndex((paragraph) => normalise(paragraph).includes(needle))
    : -1

  useEffect(() => {
    if (highlightIndex < 0) return
    highlightRef.current?.scrollIntoView({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIndex])

  if (paragraphs.length === 0) {
    return (
      <p className='text-sm text-neutral-400'>No extracted text is available for this document.</p>
    )
  }

  return (
    <div className='space-y-3 text-sm leading-relaxed text-neutral-700'>
      {paragraphs.map((paragraph, index) => {
        const isHighlighted = index === highlightIndex
        return (
          <p
            key={index}
            ref={isHighlighted ? highlightRef : undefined}
            className={isHighlighted ? 'rounded-md border-l-4 py-1.5 pl-3 pr-2' : undefined}
            style={isHighlighted
              ? {
                borderColor: 'var(--rp-accent)',
                backgroundColor: 'color-mix(in srgb, var(--rp-accent) 12%, white)',
              }
              : undefined}
          >
            {paragraph}
          </p>
        )
      })}
    </div>
  )
}

/** Extracted text wrapped in its own card, used by the web and file/text bodies. */
function ExtractedTextCard(
  { texts, passage, title = 'Extracted text' }: {
    texts: { fieldId: string; text: string }[]
    passage: string | null
    title?: string
  },
) {
  const paragraphs = useJoinedParagraphs(texts)
  return (
    <div className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
      <h2 className='text-xs font-semibold uppercase tracking-wide text-neutral-500'>{title}</h2>
      <div className='mt-3'>
        <ExtractedTextPanel paragraphs={paragraphs} passage={passage} />
      </div>
    </div>
  )
}

/**
 * Timed transcript for video/audio resources: a search filter, a scrollable
 * segment list, and click-to-seek on the shared media ref. A matching
 * `?passage=` auto-highlights and seeks (without playing) on load.
 */
function TranscriptPanel(
  { transcript, mediaRef, passage }: {
    transcript: { text: string; startSec?: number }[]
    mediaRef: RefObject<HTMLMediaElement | null>
    passage: string | null
  },
) {
  const [search, setSearch] = useState('')
  const rowRefs = useRef(new Map<number, HTMLButtonElement>())

  const needle = passageNeedle(passage)
  const highlightIndex = needle
    ? transcript.findIndex((segment) => {
      const segmentNorm = normalise(segment.text)
      return segmentNorm.includes(needle) ||
        (segmentNorm.length > 0 && needle.includes(segmentNorm))
    })
    : -1

  useEffect(() => {
    if (highlightIndex < 0) return
    rowRefs.current.get(highlightIndex)?.scrollIntoView({ block: 'center' })
    const startSec = transcript[highlightIndex]?.startSec
    if (mediaRef.current && startSec !== undefined) {
      mediaRef.current.currentTime = startSec
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIndex])

  function seekTo(startSec: number | undefined) {
    const media = mediaRef.current
    if (!media || startSec === undefined) return
    media.currentTime = startSec
    void media.play()
  }

  const trimmedSearch = search.trim().toLowerCase()
  const rows = transcript
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) =>
      trimmedSearch.length === 0 || segment.text.toLowerCase().includes(trimmedSearch)
    )

  return (
    <div className='mt-6 rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
      <h2 className='text-xs font-semibold uppercase tracking-wide text-neutral-500'>Transcript</h2>

      <label htmlFor='transcript-search' className='sr-only'>
        Search the transcript
      </label>
      <input
        id='transcript-search'
        type='text'
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder='Search the transcript'
        className='mt-3 w-full rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none'
      />

      <div className='mt-3 max-h-96 overflow-y-auto rounded-xl border border-neutral-100'>
        {rows.length === 0
          ? <p className='p-4 text-sm text-neutral-400'>No matching transcript segments.</p>
          : (
            <ul className='divide-y divide-neutral-100'>
              {rows.map(({ segment, index }) => {
                const isHighlighted = index === highlightIndex
                return (
                  <li key={index}>
                    <button
                      type='button'
                      ref={(el) => {
                        if (el) rowRefs.current.set(index, el)
                        else rowRefs.current.delete(index)
                      }}
                      onClick={() => seekTo(segment.startSec)}
                      className='flex w-full items-start gap-3 px-4 py-2.5 text-left text-sm transition-colors duration-150 hover:bg-neutral-50'
                      style={isHighlighted
                        ? { backgroundColor: 'color-mix(in srgb, var(--rp-accent) 12%, white)' }
                        : undefined}
                    >
                      <span className='shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium tabular-nums text-neutral-500'>
                        {segment.startSec !== undefined
                          ? formatTimestamp(segment.startSec)
                          : '--:--'}
                      </span>
                      <span className='text-neutral-700'>{segment.text}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
      </div>
    </div>
  )
}

function WebBody(
  { content, resourceSummary, passage }: {
    content: ResourceContent
    resourceSummary: string
    passage: string | null
  },
) {
  const pageSummary = content.summary ?? resourceSummary
  return (
    <div className='space-y-6'>
      {content.originUrl
        ? (
          <a
            href={content.originUrl}
            target='_blank'
            rel='noopener noreferrer'
            className='flex items-center justify-between gap-4 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm transition-colors duration-150 hover:border-neutral-300'
          >
            <div className='min-w-0'>
              <p className='text-xs font-semibold uppercase tracking-wide text-neutral-500'>
                Source
              </p>
              <p className='mt-1 text-sm font-medium text-neutral-900'>Visit the source page</p>
              <p className='mt-0.5 truncate text-xs text-neutral-400'>{content.originUrl}</p>
            </div>
            <span aria-hidden='true' className='shrink-0 text-neutral-400'>&rarr;</span>
          </a>
        )
        : null}

      {pageSummary
        ? (
          <div className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
            <h2 className='text-xs font-semibold uppercase tracking-wide text-neutral-500'>
              Page summary
            </h2>
            <p className='mt-2 text-sm leading-relaxed text-neutral-700'>{pageSummary}</p>
          </div>
        )
        : null}

      <ExtractedTextCard texts={content.texts} passage={passage} />
    </div>
  )
}

function PdfBody(
  { content, fileUrl, passage }: {
    content: ResourceContent
    fileUrl: string | undefined
    passage: string | null
  },
) {
  const paragraphs = useJoinedParagraphs(content.texts)
  return (
    <div className='space-y-4'>
      {fileUrl
        ? (
          <div>
            <iframe
              src={fileUrl}
              className='h-[75vh] w-full rounded-xl border border-neutral-200'
              title='PDF preview'
            />
            <a
              href={fileUrl}
              target='_blank'
              rel='noopener noreferrer'
              className='mt-2 inline-block text-sm font-medium text-neutral-500 transition-colors duration-150 hover:text-neutral-900'
            >
              Open PDF in a new tab
            </a>
          </div>
        )
        : <p className='text-sm text-neutral-400'>This PDF file is not available.</p>}

      {paragraphs.length > 0
        ? (
          <details
            className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'
            open={passage != null}
          >
            <summary className='cursor-pointer text-xs font-semibold uppercase tracking-wide text-neutral-500'>
              Extracted text
            </summary>
            <div className='mt-3'>
              <ExtractedTextPanel paragraphs={paragraphs} passage={passage} />
            </div>
          </details>
        )
        : null}
    </div>
  )
}

function MediaBody(
  { content, fileUrl, passage, kind }: {
    content: ResourceContent
    fileUrl: string | undefined
    passage: string | null
    kind: 'video' | 'audio'
  },
) {
  const mediaRef = useRef<HTMLMediaElement | null>(null)

  return (
    <div className='space-y-6'>
      {fileUrl
        ? kind === 'video'
          ? (
            <video
              ref={(el) => {
                mediaRef.current = el
              }}
              controls
              preload='metadata'
              className='w-full rounded-xl'
              src={fileUrl}
            />
          )
          : (
            <audio
              ref={(el) => {
                mediaRef.current = el
              }}
              controls
              className='w-full'
              src={fileUrl}
            />
          )
        : <p className='text-sm text-neutral-400'>This {kind} file is not available.</p>}

      {content.transcript.length > 0
        ? <TranscriptPanel transcript={content.transcript} mediaRef={mediaRef} passage={passage} />
        : null}
    </div>
  )
}

function ImageBody({ fileUrl, title }: { fileUrl: string | undefined; title: string }) {
  return fileUrl
    ? <img src={fileUrl} className='max-h-[70vh] rounded-xl' alt={title} />
    : <p className='text-sm text-neutral-400'>This image is not available.</p>
}

function TextFileBody(
  { content, passage, fileUrl }: {
    content: ResourceContent
    passage: string | null
    fileUrl: string | undefined
  },
) {
  return (
    <div className='space-y-4'>
      {fileUrl
        ? (
          <a
            href={fileUrl}
            target='_blank'
            rel='noopener noreferrer'
            className='inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors duration-150 hover:border-neutral-300 hover:text-neutral-900'
          >
            Download file
          </a>
        )
        : null}
      <ExtractedTextCard texts={content.texts} passage={passage} />
    </div>
  )
}

/** Dispatches to the type-aware body for the resource's content kind. */
function ResourceBody(
  { slug, content, resourceSummary, passage }: {
    slug: string
    content: ResourceContent
    resourceSummary: string
    passage: string | null
  },
) {
  const primaryFile = content.files[0]
  const fileUrl = primaryFile ? resourceFileUrl(slug, content.id, primaryFile.fieldId) : undefined

  switch (content.kind) {
    case 'web':
      return <WebBody content={content} resourceSummary={resourceSummary} passage={passage} />
    case 'pdf':
      return <PdfBody content={content} fileUrl={fileUrl} passage={passage} />
    case 'video':
      return <MediaBody content={content} fileUrl={fileUrl} passage={passage} kind='video' />
    case 'audio':
      return <MediaBody content={content} fileUrl={fileUrl} passage={passage} kind='audio' />
    case 'image':
      return <ImageBody fileUrl={fileUrl} title={content.title} />
    case 'text':
      return <TextFileBody content={content} passage={passage} fileUrl={undefined} />
    case 'file':
      return <TextFileBody content={content} passage={passage} fileUrl={fileUrl} />
    default:
      return null
  }
}

export function ResourceDetailPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const passage = searchParams.get('passage')

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

  const { data: content, isLoading: contentLoading } = useQuery({
    queryKey: ['resource-content', config.slug, id],
    queryFn: () => getResourceContent(config.slug, id ?? ''),
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

              {contentLoading ? <BodySkeleton /> : null}

              {!contentLoading && content
                ? (
                  <div className='mt-8'>
                    <ResourceBody
                      slug={config.slug}
                      content={content}
                      resourceSummary={resource.summary}
                      passage={passage}
                    />
                  </div>
                )
                : null}

              {!contentLoading && !content
                ? (
                  <div className='mt-8 rounded-2xl border border-dashed border-neutral-300 bg-white/60 p-6 text-center'>
                    <p className='text-sm text-neutral-500'>
                      Full content is unavailable for this resource.
                    </p>
                  </div>
                )
                : null}

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
