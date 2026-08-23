import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { Link, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import type { ResourceContent, ResourceSummary, ScoredResource } from '@research-portal/core'
import {
  ApiError,
  getRelationsGraph,
  getResource,
  getResourceContent,
  resourceFileUrl,
  searchTenantFull,
} from '../api/client.ts'
import { AnswerStream } from '../components/AnswerStream.tsx'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { SaveEvidenceButton } from '../components/SaveEvidence.tsx'
import { ErrorCard, prettyLabel, Skeleton, TypeBadge } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

/** Publish year from an ISO date, or null when the date is missing/unparseable. */
function formatYear(iso: string): string | null {
  const match = /^(\d{4})/.exec(iso)
  return match ? match[1] ?? null : null
}

/** FRDC project number embedded in a title, e.g. "...FRDC 2018-190..." -> "2018-190". */
function frdcProjectNumber(title: string): string | null {
  const match = /FRDC\s*(\d{4}-\d{3})/i.exec(title)
  return match ? match[1] ?? null : null
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

/** Significant words from a `?q=` search query - short/noise tokens are dropped. */
function queryTerms(query: string | null): string[] {
  if (!query) return []
  const words = normalise(query).split(/\s+/).filter((w) => w.length >= 3)
  return Array.from(new Set(words))
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

/** Small square section label used on every panel in this view. */
function PanelHeading({ children }: { children: ReactNode }) {
  return <h2 className='rp-eyebrow text-ink-3'>{children}</h2>
}

function DetailSkeleton() {
  return (
    <div className='rp-card p-5'>
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
    <div className='rp-card mt-6 p-5'>
      <Skeleton className='h-72 w-full' />
    </div>
  )
}

/**
 * Extracted-text paragraphs with optional passage highlighting and a transient
 * "flash" highlight for a paragraph the reader just jumped to from the Matches
 * rail. Shared by the web, PDF, text and file bodies. Each paragraph carries a
 * stable id (`doc-para-{index}`) so the rail can scroll straight to it.
 */
function ExtractedTextPanel(
  { paragraphs, passage, flashIndex }: {
    paragraphs: string[]
    passage: string | null
    flashIndex: number | null
  },
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
    return <p className='text-sm text-ink-3'>No extracted text is available for this document.</p>
  }

  return (
    <div className='rp-prose space-y-3 text-sm text-ink-2'>
      {paragraphs.map((paragraph, index) => {
        const isHighlighted = index === highlightIndex
        const isFlashed = index === flashIndex
        const emphasised = isHighlighted || isFlashed
        return (
          <p
            key={index}
            id={`doc-para-${index}`}
            ref={isHighlighted ? highlightRef : undefined}
            className={`scroll-mt-24 transition-colors duration-700 ${
              emphasised ? 'rounded-[4px] border-l-2 py-1.5 pl-3 pr-2 text-ink' : ''
            }`}
            style={emphasised
              ? {
                borderColor: 'var(--rp-accent)',
                backgroundColor: 'color-mix(in srgb, var(--rp-accent) 14%, var(--rp-surface))',
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
  { texts, passage, flashIndex, title = 'Extracted text' }: {
    texts: { fieldId: string; text: string }[]
    passage: string | null
    flashIndex: number | null
    title?: string
  },
) {
  const paragraphs = useJoinedParagraphs(texts)
  return (
    <div className='rp-card p-5'>
      <PanelHeading>{title}</PanelHeading>
      <div className='mt-3'>
        <ExtractedTextPanel paragraphs={paragraphs} passage={passage} flashIndex={flashIndex} />
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
    <div className='rp-card mt-5 p-5'>
      <PanelHeading>Transcript</PanelHeading>

      <label htmlFor='transcript-search' className='sr-only'>
        Search the transcript
      </label>
      <input
        id='transcript-search'
        type='text'
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder='Search the transcript'
        className='rp-input mt-3'
      />

      <div className='mt-3 max-h-96 overflow-y-auto rounded-[6px] border border-line'>
        {rows.length === 0
          ? <p className='p-4 text-sm text-ink-3'>No matching transcript segments.</p>
          : (
            <ul className='divide-y divide-[var(--rp-line)]'>
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
                      className='flex w-full items-start gap-3 px-3.5 py-2 text-left text-sm transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
                      style={isHighlighted
                        ? {
                          backgroundColor:
                            'color-mix(in srgb, var(--rp-accent) 14%, var(--rp-surface))',
                        }
                        : undefined}
                    >
                      <span className='shrink-0 rounded-[4px] bg-surface-2 px-1.5 py-0.5 text-xs font-medium tabular-nums text-ink-3'>
                        {segment.startSec !== undefined
                          ? formatTimestamp(segment.startSec)
                          : '--:--'}
                      </span>
                      <span className='text-ink-2'>{segment.text}</span>
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
  { content, resourceSummary, passage, flashIndex }: {
    content: ResourceContent
    resourceSummary: string
    passage: string | null
    flashIndex: number | null
  },
) {
  const pageSummary = content.summary ?? resourceSummary
  return (
    <div className='space-y-5'>
      {pageSummary
        ? (
          <div className='rp-card p-5'>
            <PanelHeading>Page summary</PanelHeading>
            <p className='mt-2 text-sm leading-relaxed text-ink-2'>{pageSummary}</p>
          </div>
        )
        : null}

      <ExtractedTextCard texts={content.texts} passage={passage} flashIndex={flashIndex} />
    </div>
  )
}

/**
 * The matched passage in its own quiet card, quoted above the PDF viewer -
 * PDFs bury the same highlight far below a tall iframe, so the reader would
 * otherwise never see it without scrolling past the embed first.
 */
function MatchedPassageCard({ passage, page }: { passage: string; page: number | null }) {
  return (
    <div className='rp-card p-4'>
      <p className='rp-eyebrow text-ink-3'>Matched passage</p>
      <blockquote
        className='mt-2 border-l-2 bg-surface-2 py-2 pl-3 pr-2 text-sm italic leading-relaxed text-ink-2'
        style={{ borderColor: 'var(--rp-accent)' }}
      >
        &ldquo;{passage}&rdquo;
      </blockquote>
      {page
        ? <p className='mt-2 text-xs font-medium tabular-nums text-ink-3'>From page {page}</p>
        : null}
    </div>
  )
}

function PdfBody(
  { content, fileUrl, passage, page, flashIndex, forceOpen }: {
    content: ResourceContent
    fileUrl: string | undefined
    passage: string | null
    page: number | null
    flashIndex: number | null
    forceOpen: boolean
  },
) {
  const paragraphs = useJoinedParagraphs(content.texts)
  const pdfSrc = fileUrl ? (page ? `${fileUrl}#page=${page}` : fileUrl) : undefined
  return (
    <div className='space-y-4'>
      {passage ? <MatchedPassageCard passage={passage} page={page} /> : null}

      {fileUrl
        ? (
          <div>
            <iframe
              src={pdfSrc}
              className='h-[60vh] w-full rounded-[8px] border border-line bg-surface sm:h-[75vh]'
              title='PDF preview'
            />
            <a
              href={pdfSrc}
              target='_blank'
              rel='noopener noreferrer'
              className='mt-2 inline-block text-sm font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
            >
              Open PDF in a new tab
            </a>
          </div>
        )
        : <p className='text-sm text-ink-3'>This PDF file is not available.</p>}

      {paragraphs.length > 0
        ? (
          <details className='rp-card p-5' open={forceOpen}>
            <summary className='rp-eyebrow cursor-pointer text-ink-3'>
              Extracted text
            </summary>
            <div className='mt-3'>
              <ExtractedTextPanel
                paragraphs={paragraphs}
                passage={passage}
                flashIndex={flashIndex}
              />
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
    <div className='space-y-5'>
      {fileUrl
        ? kind === 'video'
          ? (
            <video
              ref={(el) => {
                mediaRef.current = el
              }}
              controls
              preload='metadata'
              className='w-full rounded-[8px] border border-line'
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
        : <p className='text-sm text-ink-3'>This {kind} file is not available.</p>}

      {content.transcript.length > 0
        ? <TranscriptPanel transcript={content.transcript} mediaRef={mediaRef} passage={passage} />
        : null}
    </div>
  )
}

function ImageBody({ fileUrl, title }: { fileUrl: string | undefined; title: string }) {
  return fileUrl
    ? <img src={fileUrl} className='max-h-[70vh] rounded-[8px] border border-line' alt={title} />
    : <p className='text-sm text-ink-3'>This image is not available.</p>
}

function TextFileBody(
  { content, passage, flashIndex, fileUrl }: {
    content: ResourceContent
    passage: string | null
    flashIndex: number | null
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
            className='rp-btn rp-btn-outline'
          >
            Download file
          </a>
        )
        : null}
      <ExtractedTextCard texts={content.texts} passage={passage} flashIndex={flashIndex} />
    </div>
  )
}

/** Dispatches to the type-aware body for the resource's content kind. */
function ResourceBody(
  { slug, content, resourceSummary, passage, page, flashIndex, hasTextMatches }: {
    slug: string
    content: ResourceContent
    resourceSummary: string
    passage: string | null
    page: number | null
    flashIndex: number | null
    hasTextMatches: boolean
  },
) {
  const primaryFile = content.files[0]
  const fileUrl = primaryFile ? resourceFileUrl(slug, content.id, primaryFile.fieldId) : undefined

  switch (content.kind) {
    case 'web':
      return (
        <WebBody
          content={content}
          resourceSummary={resourceSummary}
          passage={passage}
          flashIndex={flashIndex}
        />
      )
    case 'pdf':
      return (
        <PdfBody
          content={content}
          fileUrl={fileUrl}
          passage={passage}
          page={page}
          flashIndex={flashIndex}
          forceOpen={passage != null || hasTextMatches}
        />
      )
    case 'video':
      return <MediaBody content={content} fileUrl={fileUrl} passage={passage} kind='video' />
    case 'audio':
      return <MediaBody content={content} fileUrl={fileUrl} passage={passage} kind='audio' />
    case 'image':
      return <ImageBody fileUrl={fileUrl} title={content.title} />
    case 'text':
      return (
        <TextFileBody
          content={content}
          passage={passage}
          flashIndex={flashIndex}
          fileUrl={undefined}
        />
      )
    case 'file':
      return (
        <TextFileBody
          content={content}
          passage={passage}
          flashIndex={flashIndex}
          fileUrl={fileUrl}
        />
      )
    default:
      return null
  }
}

/** Metadata the reader actually has to show - kind, topics, publish date, origin link. */
function AboutPanel(
  { slug, resource, content, topicLabel, organisation }: {
    slug: string
    resource: ResourceSummary
    content: ResourceContent | undefined
    topicLabel: (id: string) => string | undefined
    organisation: string
  },
) {
  const originUrl = content?.originUrl
  const year = resource.published ? formatYear(resource.published) : null
  const projectNumber = frdcProjectNumber(resource.title)

  return (
    <div className='rp-card p-4'>
      <PanelHeading>About this document</PanelHeading>

      <div className='mt-3 flex flex-wrap items-center gap-2'>
        <TypeBadge type={resource.type} />
        {resource.kind
          ? (
            <span className='rp-badge rp-badge-quiet'>
              {prettyLabel(resource.kind, organisation)}
            </span>
          )
          : null}
        {year
          ? <span className='text-xs font-medium tabular-nums text-ink-3'>Published {year}</span>
          : null}
        {projectNumber
          ? (
            <span className='text-xs font-medium tabular-nums text-ink-3'>
              Project {projectNumber}
            </span>
          )
          : null}
      </div>

      {resource.topicIds.length > 0
        ? (
          <div className='mt-3 flex flex-wrap gap-1'>
            {resource.topicIds.map((topicId) => {
              const label = topicLabel(topicId)
              if (!label) return null
              return (
                <span
                  key={topicId}
                  className='rounded-[4px] bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2'
                >
                  {label}
                </span>
              )
            })}
          </div>
        )
        : null}

      {originUrl
        ? (
          <a
            href={originUrl}
            target='_blank'
            rel='noopener noreferrer'
            className='rp-focus mt-3 flex items-center gap-1.5 rounded-[4px] text-sm font-medium underline decoration-dotted underline-offset-2'
            style={{ color: 'var(--rp-accent)' }}
          >
            View original <span aria-hidden='true'>&rarr;</span>
          </a>
        )
        : null}

      <div className='mt-3 border-t border-line pt-3'>
        <SaveEvidenceButton
          slug={slug}
          label='Save document to investigation'
          evidence={{
            passage: resource.summary,
            resourceId: resource.id,
            resourceTitle: resource.title,
          }}
        />
      </div>
    </div>
  )
}

/**
 * Related work for the right rail. First choice: the entity relations graph -
 * an edge whose source or target name appears in this document's title links
 * to that entity's dossier. If the graph has nothing to say, fall back to a
 * semantic search on the title and link to the top matching documents
 * instead. The section renders nothing at all when neither yields a result -
 * an honest omission beats a fake "related" list.
 */
function useRelatedWork(slug: string, title: string, excludeId: string) {
  const relationsQuery = useQuery({
    queryKey: ['relations-graph', slug],
    queryFn: () => getRelationsGraph(slug),
    staleTime: 5 * 60 * 1000,
  })

  const graphMatches = useMemo(() => {
    if (!relationsQuery.data) return []
    const haystack = title.toLowerCase()
    const names = new Set<string>()
    for (const edge of relationsQuery.data.edges) {
      const source = edge.source.trim()
      const target = edge.target.trim()
      if (source.length > 0 && haystack.includes(source.toLowerCase())) names.add(target)
      else if (target.length > 0 && haystack.includes(target.toLowerCase())) names.add(source)
    }
    return Array.from(names).filter((n) => n.length > 0).slice(0, 5)
  }, [relationsQuery.data, title])

  const fallbackEnabled = relationsQuery.isSuccess && graphMatches.length === 0 &&
    title.trim().length > 0

  const searchQuery = useQuery({
    queryKey: ['related-search', slug, title],
    queryFn: () => searchTenantFull(slug, title, { mode: 'semantic' }),
    enabled: fallbackEnabled,
  })

  const fallbackResults = useMemo(() => {
    if (!searchQuery.data) return []
    return searchQuery.data.resources.filter((r) => r.id !== excludeId).slice(0, 5)
  }, [searchQuery.data, excludeId])

  const loading = relationsQuery.isLoading || (fallbackEnabled && searchQuery.isLoading)
  const kind: 'graph' | 'search' | null = graphMatches.length > 0
    ? 'graph'
    : fallbackResults.length > 0
    ? 'search'
    : null

  return { loading, kind, graphMatches, fallbackResults }
}

function RelatedPanel(
  { slug, title, excludeId }: { slug: string; title: string; excludeId: string },
) {
  const { loading, kind, graphMatches, fallbackResults } = useRelatedWork(slug, title, excludeId)

  if (loading) {
    return (
      <div className='rp-card p-4'>
        <PanelHeading>Related</PanelHeading>
        <div className='mt-3 space-y-2' aria-hidden='true'>
          <div className='rp-shimmer bg-surface-3 h-3.5 w-full rounded-[4px]' />
          <div className='rp-shimmer bg-surface-3 h-3.5 w-5/6 rounded-[4px]' />
          <div className='rp-shimmer bg-surface-3 h-3.5 w-2/3 rounded-[4px]' />
        </div>
      </div>
    )
  }

  if (!kind) return null

  return (
    <div className='rp-card p-4'>
      <PanelHeading>Related</PanelHeading>
      <ul className='mt-3 space-y-2'>
        {kind === 'graph'
          ? graphMatches.map((name) => (
            <li key={name}>
              <Link
                to={`/t/${slug}/entity/${encodeURIComponent(name)}`}
                className='rp-focus block truncate rounded-[4px] text-sm font-medium text-[var(--rp-ink-2)] underline decoration-dotted underline-offset-2 transition-colors duration-150 hover:text-[var(--rp-ink)]'
              >
                {name}
              </Link>
            </li>
          ))
          : fallbackResults.map((r: ScoredResource) => (
            <li key={r.id}>
              <Link
                to={`/t/${slug}/library/${r.id}`}
                className='rp-focus block truncate rounded-[4px] text-sm font-medium text-[var(--rp-ink-2)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
              >
                {r.title}
              </Link>
            </li>
          ))}
      </ul>
    </div>
  )
}

/** The "Matches in this document" jump list, driven by a `?q=` search query. */
function MatchesPanel(
  { indices, paragraphs, onJump }: {
    indices: number[]
    paragraphs: string[]
    onJump: (index: number) => void
  },
) {
  if (indices.length === 0) return null

  return (
    <div className='rp-card p-4'>
      <PanelHeading>Matches in this document ({indices.length})</PanelHeading>
      <ul className='mt-3 space-y-1'>
        {indices.map((index) => (
          <li key={index}>
            <button
              type='button'
              onClick={() => onJump(index)}
              className='rp-focus block w-full rounded-[4px] px-2 py-1.5 text-left text-xs leading-relaxed text-ink-2 transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
            >
              <span className='rp-clamp-2'>{paragraphs[index]}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Floating "Save selection" action that appears near a text selection made
 * inside the extracted content, so a passage can be promoted to Evidence
 * without leaving the reader. Dismissed on scroll, Escape, or a click outside
 * both the selection and the popover itself.
 */
function SelectionSaveBar(
  { slug, resourceId, resourceTitle, selection, onDismiss }: {
    slug: string
    resourceId: string
    resourceTitle: string
    selection: { text: string; top: number; left: number }
    onDismiss: () => void
  },
) {
  const popoverRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onScroll = () => onDismiss()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) onDismiss()
    }
    globalThis.addEventListener('scroll', onScroll, { capture: true, passive: true })
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => {
      globalThis.removeEventListener('scroll', onScroll, { capture: true })
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
    }
  }, [onDismiss])

  const top = Math.max(8, selection.top - 46)
  const left = Math.min(Math.max(8, selection.left), globalThis.innerWidth - 180)

  return createPortal(
    <div
      ref={popoverRef}
      className='rp-shadow-lg fixed z-[80] rounded-[8px] border border-line bg-surface p-1'
      style={{ top, left }}
    >
      <SaveEvidenceButton
        slug={slug}
        label='Save selection'
        evidence={{
          passage: selection.text.slice(0, 2000),
          resourceId,
          resourceTitle,
        }}
      />
    </div>,
    document.body,
  )
}

export function ResourceDetailPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const passage = searchParams.get('passage')
  const qParam = searchParams.get('q')
  const pageParam = Number(searchParams.get('page'))
  const page = Number.isInteger(pageParam) && pageParam > 0 ? pageParam : null

  const [askDraft, setAskDraft] = useState('')
  const [askQuery, setAskQuery] = useState('')

  const contentRef = useRef<HTMLDivElement | null>(null)
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(
    null,
  )

  const [flashIndex, setFlashIndex] = useState<number | null>(null)
  const flashTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (flashTimeout.current) globalThis.clearTimeout(flashTimeout.current)
    }
  }, [])

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

  const paragraphs = useJoinedParagraphs(content?.texts ?? [])
  const matchTerms = useMemo(() => queryTerms(qParam), [qParam])
  const matchIndices = useMemo(() => {
    if (matchTerms.length === 0) return []
    return paragraphs
      .map((paragraph, index) => ({ normalised: normalise(paragraph), index }))
      .filter(({ normalised }) => matchTerms.some((term) => normalised.includes(term)))
      .map(({ index }) => index)
  }, [paragraphs, matchTerms])

  function jumpToParagraph(index: number) {
    document.getElementById(`doc-para-${index}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    })
    if (flashTimeout.current) globalThis.clearTimeout(flashTimeout.current)
    setFlashIndex(index)
    flashTimeout.current = globalThis.setTimeout(() => setFlashIndex(null), 1500)
  }

  function handleContentMouseUp() {
    const sel = globalThis.getSelection()
    if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
      setSelection(null)
      return
    }
    const anchor = sel.anchorNode
    if (!anchor || !contentRef.current?.contains(anchor)) {
      setSelection(null)
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    setSelection({ text: sel.toString(), top: rect.top, left: rect.left })
  }

  function handleAskSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = askDraft.trim()
    if (trimmed.length === 0) return
    setAskQuery(trimmed)
  }

  const topicLabel = (topicId: string) => config.topics.find((topic) => topic.id === topicId)?.label

  return (
    <main className='mx-auto max-w-5xl px-6 py-8'>
      <Link
        to={`/t/${config.slug}/library`}
        className='text-sm font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
      >
        &larr; Back to library
      </Link>

      <div className='mt-4'>
        {isLoading ? <DetailSkeleton /> : null}

        {isError && notFound
          ? (
            <div className='rounded-[10px] border border-dashed border-line bg-surface-2 p-6'>
              <p className='text-sm font-semibold text-ink'>This document does not exist</p>
              <p className='mt-1 text-sm text-ink-2'>
                It may have been removed, or the link is out of date.
              </p>
              <Link
                to={`/t/${config.slug}/library`}
                className='rp-btn rp-btn-primary mt-4'
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
            <div className='grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_280px]'>
              <div className='min-w-0'>
                <article className='rp-card p-5'>
                  <div className='flex items-start justify-between gap-5'>
                    <div className='min-w-0 flex-1'>
                      <h1 className='rp-display text-2xl text-ink'>
                        {resource.title}
                      </h1>
                      <p className='mt-2 text-sm leading-relaxed text-ink-2'>
                        {resource.summary}
                      </p>

                      {resource.keyFacts.length > 0
                        ? (
                          <div className='mt-5 border-t border-line pt-4'>
                            <PanelHeading>Key facts</PanelHeading>
                            <ol className='mt-2 space-y-1.5'>
                              {resource.keyFacts.map((fact, index) => (
                                <li key={index} className='flex gap-2 text-sm text-ink-2'>
                                  <span className='font-medium tabular-nums text-ink-3'>
                                    {index + 1}.
                                  </span>
                                  <span>{fact}</span>
                                </li>
                              ))}
                            </ol>
                          </div>
                        )
                        : null}
                    </div>

                    <div className='hidden h-24 w-36 shrink-0 overflow-hidden rounded-[8px] border border-line sm:block'>
                      <ResourceThumb slug={config.slug} id={resource.id} type={resource.type} />
                    </div>
                  </div>
                </article>

                {contentLoading ? <BodySkeleton /> : null}

                {!contentLoading && content
                  ? (
                    <div
                      className='relative mt-6'
                      ref={contentRef}
                      onMouseUp={handleContentMouseUp}
                    >
                      <ResourceBody
                        slug={config.slug}
                        content={content}
                        resourceSummary={resource.summary}
                        passage={passage}
                        page={page}
                        flashIndex={flashIndex}
                        hasTextMatches={matchIndices.length > 0}
                      />
                    </div>
                  )
                  : null}

                {!contentLoading && !content
                  ? (
                    <div className='mt-6 rounded-[10px] border border-dashed border-line bg-surface-2 p-5'>
                      <p className='text-sm text-ink-2'>
                        Full content is unavailable for this resource.
                      </p>
                    </div>
                  )
                  : null}

                <section className='rp-card mt-6 p-5'>
                  <PanelHeading>Ask this document</PanelHeading>
                  <form onSubmit={handleAskSubmit} className='mt-3'>
                    <label htmlFor='ask-document' className='sr-only'>
                      Ask a question about {resource.title}
                    </label>
                    <div className='flex items-center gap-2 rounded-[8px] border border-line bg-surface p-1.5 pl-3'>
                      <input
                        id='ask-document'
                        type='text'
                        value={askDraft}
                        onChange={(event) => setAskDraft(event.target.value)}
                        placeholder='Ask a question about this document'
                        className='min-w-0 flex-1 border-0 bg-transparent py-1.5 text-sm text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none'
                      />
                      <button
                        type='submit'
                        className='rp-btn rp-btn-primary shrink-0 font-semibold'
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
                          onRetry={() => setAskQuery(askQuery)}
                        />
                      </div>
                    )
                    : null}
                </section>
              </div>

              <aside className='space-y-5 lg:sticky lg:top-20 lg:self-start'>
                <AboutPanel
                  slug={config.slug}
                  resource={resource}
                  content={content}
                  topicLabel={topicLabel}
                  organisation={config.branding.organisation}
                />
                <MatchesPanel
                  indices={matchIndices}
                  paragraphs={paragraphs}
                  onJump={jumpToParagraph}
                />
                <RelatedPanel slug={config.slug} title={resource.title} excludeId={resource.id} />
              </aside>
            </div>
          )
          : null}
      </div>

      {selection && resource
        ? (
          <SelectionSaveBar
            slug={config.slug}
            resourceId={resource.id}
            resourceTitle={resource.title}
            selection={selection}
            onDismiss={() => setSelection(null)}
          />
        )
        : null}
    </main>
  )
}
