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
  getResource,
  getResourceContent,
  resourceFileUrl,
  searchTenantFull,
} from '../api/client.ts'
import { AnswerStream } from '../components/AnswerStream.tsx'
import { PdfReader } from '../components/PdfReader.tsx'
import { ResourceThumb } from '../components/ResourceThumb.tsx'
import { SaveEvidenceButton } from '../components/SaveEvidence.tsx'
import { EmptyState, ErrorCard, prettyLabel, Skeleton, TypeBadge } from '../components/ui.tsx'
import {
  blockPlainText,
  buildRelatedQuery,
  type DocBlock,
  parseDocBlocks,
  selectRecommendations,
  selectViewerVariant,
} from '../lib/resource-view.ts'
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

/** Small eyebrow section label used on every panel in this view. */
function PanelHeading({ children }: { children: ReactNode }) {
  return <h2 className='rp-eyebrow text-ink-3'>{children}</h2>
}

/**
 * Inline markdown (bold, italic, inline code, links) rendered as React nodes -
 * never as raw HTML, so authored emphasis reads correctly without an injection
 * surface. Anything it does not recognise is passed straight through as text.
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const k = `${keyPrefix}-${key++}`
    if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(<strong key={k}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      nodes.push(
        <code key={k} className='rounded-[4px] bg-surface-2 px-1 py-0.5 text-[0.85em]'>
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (link) {
        nodes.push(
          <a
            key={k}
            href={link[2]}
            target='_blank'
            rel='noopener noreferrer'
            className='rp-focus rounded-[3px] underline decoration-dotted underline-offset-2'
            style={{ color: 'var(--rp-accent)' }}
          >
            {link[1]}
          </a>,
        )
      } else {
        nodes.push(token)
      }
    } else {
      nodes.push(<em key={k}>{token.slice(1, -1)}</em>)
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

const HEADING_CLASSES: Record<number, string> = {
  1: 'rp-display text-xl text-ink mt-6 first:mt-0',
  2: 'rp-display text-lg text-ink mt-6 first:mt-0',
  3: 'font-semibold text-base text-ink mt-5',
  4: 'font-semibold text-sm text-ink mt-4',
  5: 'font-semibold text-sm text-ink mt-4',
  6: 'font-semibold text-sm text-ink-2 mt-4',
}

/**
 * Renders one parsed document block, anchored `doc-block-{index}` so the
 * "Matches" rail and passage highlighting can scroll to it, with a transient
 * flash and a persistent passage highlight when this block is the target.
 */
function DocBlockView(
  { block, emphasised, setRef }: {
    block: DocBlock
    emphasised: boolean
    setRef: ((el: HTMLElement | null) => void) | undefined
  },
) {
  const emphasisClass = emphasised ? 'rounded-[4px] border-l-2 py-1.5 pl-3 pr-2 text-ink' : ''
  const emphasisStyle = emphasised
    ? {
      borderColor: 'var(--rp-accent)',
      backgroundColor: 'color-mix(in srgb, var(--rp-accent) 14%, var(--rp-surface))',
    }
    : undefined
  const base = `doc-block scroll-mt-24 transition-colors duration-700 ${emphasisClass}`
  const id = `doc-block-${block.index}`

  switch (block.kind) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level))
      const Tag = `h${level}` as 'h2'
      return (
        <Tag
          id={id}
          ref={setRef}
          style={emphasisStyle}
          className={`${HEADING_CLASSES[level]} ${base}`}
        >
          {renderInline(block.text, `h-${block.index}`)}
        </Tag>
      )
    }
    case 'list':
      return block.ordered
        ? (
          <ol
            id={id}
            ref={setRef}
            style={emphasisStyle}
            className={`${base} list-decimal space-y-1.5 pl-6`}
          >
            {block.items.map((item, i) => (
              <li key={i} className='pl-1'>{renderInline(item, `li-${block.index}-${i}`)}</li>
            ))}
          </ol>
        )
        : (
          <ul
            id={id}
            ref={setRef}
            style={emphasisStyle}
            className={`${base} list-disc space-y-1.5 pl-6`}
          >
            {block.items.map((item, i) => (
              <li key={i} className='pl-1'>{renderInline(item, `li-${block.index}-${i}`)}</li>
            ))}
          </ul>
        )
    case 'table':
      return (
        <div id={id} ref={setRef} style={emphasisStyle} className={`${base} overflow-x-auto`}>
          <table className='w-full border-collapse text-sm'>
            <thead>
              <tr>
                {block.headers.map((h, i) => (
                  <th
                    key={i}
                    className='border-b border-line px-3 py-2 text-left font-semibold text-ink'
                  >
                    {renderInline(h, `th-${block.index}-${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className='border-b border-line px-3 py-2 align-top text-ink-2'>
                      {renderInline(cell, `td-${block.index}-${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'code':
      return (
        <pre
          id={id}
          ref={setRef}
          style={emphasisStyle}
          className={`${base} overflow-x-auto rounded-[6px] bg-surface-2 p-3 text-xs leading-relaxed text-ink-2`}
        >
          <code>{block.text}</code>
        </pre>
      )
    case 'quote':
      return (
        <blockquote
          id={id}
          ref={setRef}
          style={emphasisStyle}
          className={`${base} border-l-2 border-line pl-3 italic text-ink-2`}
        >
          {renderInline(block.text, `q-${block.index}`)}
        </blockquote>
      )
    default:
      return (
        <p id={id} ref={setRef} style={emphasisStyle} className={`${base} leading-relaxed`}>
          {renderInline(block.text, `p-${block.index}`)}
        </p>
      )
  }
}

/**
 * The structured reading pane for an authored/extracted document body. Renders
 * parsed markdown blocks (headings, lists, tables, quotes) rather than a
 * flattened text dump, while keeping the passage/`?q=` highlight and the
 * jump-to-block behaviour. A leading level-1 heading equal to the resource
 * title is dropped, since the page shows the title in its own header.
 */
function DocumentReader(
  { blocks, title, passage, flashIndex }: {
    blocks: DocBlock[]
    title: string
    passage: string | null
    flashIndex: number | null
  },
) {
  const highlightRef = useRef<HTMLElement | null>(null)
  const needle = passageNeedle(passage)
  const highlightIndex = needle
    ? blocks.findIndex((block) => normalise(blockPlainText(block)).includes(needle))
    : -1

  useEffect(() => {
    if (highlightIndex < 0) return
    highlightRef.current?.scrollIntoView({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIndex])

  if (blocks.length === 0) {
    return <p className='text-sm text-ink-3'>No readable text is available for this document.</p>
  }

  const titleNorm = normalise(title)
  return (
    <div className='rp-prose rp-measure text-sm text-ink-2'>
      {blocks.map((block, i) => {
        if (
          i === 0 && block.kind === 'heading' && block.level === 1 &&
          normalise(block.text) === titleNorm
        ) {
          return null
        }
        const emphasised = block.index === highlightIndex || block.index === flashIndex
        return (
          <DocBlockView
            key={block.index}
            block={block}
            emphasised={emphasised}
            setRef={block.index === highlightIndex
              ? (el) => (highlightRef.current = el)
              : undefined}
          />
        )
      })}
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

/**
 * The matched passage quoted above the PDF viewer - PDFs bury the same
 * highlight far below a tall canvas, so the reader would otherwise never see
 * it without scrolling past the embed first.
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

/** A prominent link to download or open the original stored file. */
function OriginalFileActions(
  { fileUrl, label }: { fileUrl: string; label: string },
) {
  return (
    <div className='flex flex-wrap gap-2'>
      <a href={fileUrl} download className='rp-btn rp-btn-primary font-semibold'>
        {label}
      </a>
      <a
        href={fileUrl}
        target='_blank'
        rel='noopener noreferrer'
        className='rp-btn rp-btn-outline'
      >
        Open in a new tab
      </a>
    </div>
  )
}

/**
 * Honest viewer for an Office document (Word/PowerPoint/Excel), which browsers
 * cannot render natively. When the platform generated a browser-renderable
 * rendition (a PDF/image preview) it is shown inline; otherwise the original
 * is offered for download alongside its thumbnail, and the extracted text is
 * shown clearly labelled as a text extraction - never passed off as the
 * document itself.
 */
function OfficeBody(
  { slug, content, fileUrl }: {
    slug: string
    content: ResourceContent
    fileUrl: string | undefined
  },
) {
  const preview = content.preview
  const previewUrl = preview ? resourceFileUrl(slug, content.id, preview.fieldId) : undefined

  if (previewUrl && preview?.contentType === 'application/pdf') {
    return (
      <div className='space-y-4'>
        <p className='text-xs text-ink-3'>
          Showing a PDF rendition of the original document.
        </p>
        <PdfReader fileUrl={previewUrl} title={content.title} initialPage={null} />
        {fileUrl ? <OriginalFileActions fileUrl={fileUrl} label='Download original' /> : null}
      </div>
    )
  }

  return (
    <div className='space-y-4'>
      <div className='flex flex-col gap-4 rounded-[8px] border border-line bg-surface-2 p-5 sm:flex-row sm:items-center'>
        <div className='h-28 w-40 shrink-0 overflow-hidden rounded-[6px] border border-line'>
          {previewUrl
            ? (
              <img
                src={previewUrl}
                alt={`Preview of ${content.title}`}
                className='h-full w-full object-cover'
              />
            )
            : <ResourceThumb slug={slug} id={content.id} type='document' />}
        </div>
        <div className='min-w-0 flex-1'>
          <p className='text-sm font-semibold text-ink'>Original document</p>
          <p className='mt-1 text-sm leading-relaxed text-ink-2'>
            This is an Office document. Browsers cannot display it in place, so download the
            original to read it exactly as authored.
          </p>
          {fileUrl
            ? (
              <div className='mt-3'>
                <OriginalFileActions fileUrl={fileUrl} label='Download original' />
              </div>
            )
            : <p className='mt-3 text-sm text-ink-3'>The original file is not available.</p>}
        </div>
      </div>
    </div>
  )
}

/** Dispatches to the type-aware primary viewer for the resource's content. */
function ResourceViewer(
  { slug, content, blocks, passage, page, flashIndex, hasTextMatches }: {
    slug: string
    content: ResourceContent
    blocks: DocBlock[]
    passage: string | null
    page: number | null
    flashIndex: number | null
    hasTextMatches: boolean
  },
) {
  const primaryFile = content.files[0]
  const fileUrl = primaryFile ? resourceFileUrl(slug, content.id, primaryFile.fieldId) : undefined
  const variant = selectViewerVariant(content.kind)
  const mediaRef = useRef<HTMLMediaElement | null>(null)

  switch (variant) {
    case 'pdf':
      return (
        <div className='space-y-4'>
          {passage ? <MatchedPassageCard passage={passage} page={page} /> : null}
          {fileUrl
            ? <PdfReader fileUrl={fileUrl} title={content.title} initialPage={page} />
            : (
              <EmptyState
                title='This PDF is not available'
                description='The original file could not be loaded. The extracted text below is a machine reading of the document.'
              />
            )}
          {blocks.length > 0
            ? (
              <details className='rp-card p-5' open={passage != null || hasTextMatches}>
                <summary className='rp-eyebrow cursor-pointer text-ink-3'>
                  Extracted text
                </summary>
                <div className='mt-3'>
                  <DocumentReader
                    blocks={blocks}
                    title={content.title}
                    passage={passage}
                    flashIndex={flashIndex}
                  />
                </div>
              </details>
            )
            : null}
        </div>
      )
    case 'video':
      return (
        <div className='space-y-5'>
          {fileUrl
            ? (
              <video
                ref={(el) => (mediaRef.current = el)}
                controls
                preload='metadata'
                className='w-full rounded-[8px] border border-line bg-black'
                src={fileUrl}
              />
            )
            : <EmptyState title='This video is not available' />}
          {content.transcript.length > 0
            ? (
              <TranscriptPanel
                transcript={content.transcript}
                mediaRef={mediaRef}
                passage={passage}
              />
            )
            : null}
        </div>
      )
    case 'audio':
      return (
        <div className='space-y-5'>
          {fileUrl
            ? (
              <audio
                ref={(el) => (mediaRef.current = el)}
                controls
                className='w-full'
                src={fileUrl}
              />
            )
            : <EmptyState title='This audio is not available' />}
          {content.transcript.length > 0
            ? (
              <TranscriptPanel
                transcript={content.transcript}
                mediaRef={mediaRef}
                passage={passage}
              />
            )
            : null}
        </div>
      )
    case 'image':
      return fileUrl
        ? (
          <img
            src={fileUrl}
            className='max-h-[75vh] w-full rounded-[8px] border border-line object-contain'
            alt={content.title}
          />
        )
        : <EmptyState title='This image is not available' />
    case 'office':
      return <OfficeBody slug={slug} content={content} fileUrl={fileUrl} />
    default:
      // web / text / file - the structured reading pane. A downloadable file
      // (a non-office attachment) gets a download action above the reader.
      return (
        <div className='space-y-4'>
          {content.kind === 'file' && fileUrl
            ? <OriginalFileActions fileUrl={fileUrl} label='Download file' />
            : null}
          <DocumentReader
            blocks={blocks}
            title={content.title}
            passage={passage}
            flashIndex={flashIndex}
          />
        </div>
      )
  }
}

/**
 * Top-of-page identity: type/kind badges, the document title, its topic tags,
 * and the primary Save-to-investigation action - shown above the viewer so the
 * reader knows what they are looking at, and can act on it, before scrolling.
 * The title spans the full content width; the actions sit beside it on wide
 * screens and stack beneath it on narrow ones.
 */
function ResourceHeader(
  { slug, resource, originUrl, topicLabel, organisation }: {
    slug: string
    resource: ResourceSummary
    originUrl: string | undefined
    topicLabel: (id: string) => string | undefined
    organisation: string
  },
) {
  const year = resource.published ? formatYear(resource.published) : null
  const projectNumber = frdcProjectNumber(resource.sourceName ?? resource.title)

  return (
    <header className='mt-4'>
      <div className='flex flex-wrap items-center gap-2'>
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

      <div className='mt-3 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-8'>
        <div className='min-w-0'>
          <h1 className='rp-display text-2xl leading-tight text-ink sm:text-[1.75rem]'>
            {resource.title}
          </h1>
          {resource.sourceName
            ? (
              <p className='mt-1 text-xs tabular-nums text-ink-3'>
                Source file <span className='font-medium'>{resource.sourceName}</span>
              </p>
            )
            : null}
          {resource.topicIds.length > 0
            ? (
              <div className='mt-3 flex flex-wrap gap-1.5'>
                {resource.topicIds.map((topicId) => {
                  const label = topicLabel(topicId)
                  if (!label) return null
                  return (
                    <Link
                      key={topicId}
                      to={`/t/${slug}/library?topics=${encodeURIComponent(topicId)}`}
                      className='rp-focus rounded-[4px] bg-surface-2 px-2 py-1 text-[11px] font-medium text-ink-2 transition-colors duration-150 hover:text-ink'
                    >
                      {label}
                    </Link>
                  )
                })}
              </div>
            )
            : null}
        </div>

        <div className='flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 lg:justify-end'>
          <SaveEvidenceButton
            slug={slug}
            label='Save to investigation'
            evidence={{
              passage: resource.summary,
              resourceId: resource.id,
              resourceTitle: resource.title,
            }}
          />
          {originUrl
            ? (
              <a
                href={originUrl}
                target='_blank'
                rel='noopener noreferrer'
                className='rp-focus flex items-center gap-1.5 rounded-[4px] text-sm font-medium underline decoration-dotted underline-offset-2'
                style={{ color: 'var(--rp-accent)' }}
              >
                View original source <span aria-hidden='true'>&rarr;</span>
              </a>
            )
            : null}
        </div>
      </div>
    </header>
  )
}

/**
 * The "what is this" reading context shown directly under the viewer,
 * YouTube-style beneath the video: the document summary and its key facts.
 * The extracted/authored body lives inside the viewer itself (collapsible for
 * PDFs, the reading pane for documents), so this panel stays a tight overview.
 */
function ResourceContext({ resource }: { resource: ResourceSummary }) {
  return (
    <article className='rp-card p-5 sm:p-6' aria-labelledby='summary-heading'>
      <h2 id='summary-heading' className='rp-eyebrow text-ink-3'>Summary</h2>
      <p className='rp-measure mt-2 text-sm leading-relaxed text-ink-2'>{resource.summary}</p>

      {resource.keyTakeaways && resource.keyTakeaways.length > 0
        ? (
          <div className='mt-5 border-t border-line pt-4'>
            <PanelHeading>Key takeaways</PanelHeading>
            <ul className='rp-measure mt-2 space-y-1.5'>
              {resource.keyTakeaways.map((point, index) => (
                <li key={index} className='flex gap-2 text-sm text-ink-2'>
                  <span
                    aria-hidden='true'
                    className='mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--rp-accent)]'
                  />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>
        )
        : null}

      {resource.quotesOfInterest && resource.quotesOfInterest.length > 0
        ? (
          <div className='mt-5 border-t border-line pt-4'>
            <PanelHeading>Quotes of interest</PanelHeading>
            <div className='rp-measure mt-2 space-y-2.5'>
              {resource.quotesOfInterest.map((quote, index) => (
                <blockquote
                  key={index}
                  className='border-l-2 pl-3 text-sm italic leading-relaxed text-ink-2'
                  style={{ borderColor: 'var(--rp-accent)' }}
                >
                  {quote}
                </blockquote>
              ))}
            </div>
          </div>
        )
        : null}

      {resource.keyFacts.length > 0
        ? (
          <div className='mt-5 border-t border-line pt-4'>
            <PanelHeading>Key facts</PanelHeading>
            <ol className='rp-measure mt-2 space-y-1.5'>
              {resource.keyFacts.map((fact, index) => (
                <li key={index} className='flex gap-2 text-sm text-ink-2'>
                  <span className='font-medium tabular-nums text-ink-3'>{index + 1}.</span>
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

/**
 * The per-resource chat, scoped to this one document (its `resourceId` is
 * passed to `/ask`, which filters retrieval to this resource server-side).
 * Surfaced prominently, always available, with starter prompts as an empty
 * state rather than a blank box.
 */
function DocumentChat({ slug, resource }: { slug: string; resource: ResourceSummary }) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    setQuery(trimmed)
  }

  function askStarter(text: string) {
    setDraft(text)
    setQuery(text)
  }

  const starters = [
    'Summarise the key findings',
    'What are the main recommendations?',
    'What methods were used?',
  ]

  return (
    <section className='rp-card p-5 sm:p-6' aria-labelledby='chat-heading'>
      <div className='flex items-center gap-2'>
        <svg
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth={1.8}
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'
          className='h-4 w-4 text-ink-3'
        >
          <path d='M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z' />
        </svg>
        <h2 id='chat-heading' className='text-sm font-semibold text-ink'>
          Chat with this document
        </h2>
      </div>
      <p className='mt-1 text-sm text-ink-3'>
        Answers are grounded in this document only, with citations.
      </p>

      <form onSubmit={submit} className='mt-4'>
        <label htmlFor='ask-document' className='sr-only'>
          Ask a question about {resource.title}
        </label>
        <div className='flex items-center gap-2 rounded-[8px] border border-line bg-surface p-1.5 pl-3'>
          <input
            id='ask-document'
            type='text'
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder='Ask a question about this document'
            className='min-w-0 flex-1 border-0 bg-transparent py-1.5 text-sm text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none'
          />
          <button type='submit' className='rp-btn rp-btn-primary shrink-0 font-semibold'>
            Ask
          </button>
        </div>
      </form>

      {query.trim().length > 0
        ? (
          <div className='mt-4'>
            <AnswerStream
              slug={slug}
              request={{ query, resourceId: resource.id }}
              onRetry={() => setQuery(query)}
            />
          </div>
        )
        : (
          <div className='mt-3 flex flex-wrap gap-2'>
            {starters.map((text) => (
              <button
                key={text}
                type='button'
                onClick={() => askStarter(text)}
                className='rp-focus rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors duration-150 hover:text-ink'
              >
                {text}
              </button>
            ))}
          </div>
        )}
    </section>
  )
}

/** One recommendation card: thumbnail + title + type, linking onward. */
function RecommendationCard(
  { slug, resource }: { slug: string; resource: ScoredResource },
) {
  return (
    <li>
      <Link
        to={`/t/${slug}/library/${resource.id}`}
        className='rp-focus group flex gap-3 rounded-[8px] p-1.5 transition-colors duration-150 hover:bg-[var(--rp-surface-2)]'
      >
        <div className='h-16 w-24 shrink-0 overflow-hidden rounded-[6px] border border-line'>
          <ResourceThumb slug={slug} id={resource.id} type={resource.type} />
        </div>
        <div className='min-w-0 flex-1'>
          <p className='rp-clamp-2 text-sm font-medium leading-snug text-ink-2 transition-colors duration-150 group-hover:text-ink'>
            {resource.title}
          </p>
          <span className='mt-1 inline-block text-[11px] uppercase tracking-[0.06em] text-ink-3'>
            {resource.type}
          </span>
        </div>
      </Link>
    </li>
  )
}

/**
 * The right-hand "you might also want" rail: a semantic find on this
 * document's title + summary, cleaned of the current resource and any
 * system/junk files, presented as onward links for continuous
 * resource-to-resource browsing.
 */
function RecommendationsRail(
  { slug, resource }: { slug: string; resource: ResourceSummary },
) {
  const relatedQuery = buildRelatedQuery(resource.title, resource.summary)
  const query = useQuery({
    queryKey: ['related-search', slug, resource.id, relatedQuery],
    queryFn: () => searchTenantFull(slug, relatedQuery, { mode: 'semantic' }),
    enabled: relatedQuery.length > 0,
    staleTime: 5 * 60 * 1000,
  })

  const recommendations = useMemo(
    () => query.data ? selectRecommendations(query.data.resources, resource.id) : [],
    [query.data, resource.id],
  )

  return (
    <div className='rp-card p-4'>
      <PanelHeading>You might also want</PanelHeading>
      {query.isLoading
        ? (
          <div className='mt-3 space-y-3' aria-hidden='true'>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className='flex gap-3'>
                <Skeleton className='h-16 w-24 shrink-0 rounded-[6px]' />
                <div className='flex-1 space-y-1.5 py-1'>
                  <Skeleton className='h-3.5 w-full' />
                  <Skeleton className='h-3.5 w-2/3' />
                </div>
              </div>
            ))}
          </div>
        )
        : query.isError
        ? (
          <p className='mt-3 text-sm text-ink-3'>
            Related resources could not be loaded right now.
          </p>
        )
        : recommendations.length === 0
        ? <p className='mt-3 text-sm text-ink-3'>No related resources found yet.</p>
        : (
          <ul className='mt-2 space-y-1'>
            {recommendations.map((r) => <RecommendationCard key={r.id} slug={slug} resource={r} />)}
          </ul>
        )}
    </div>
  )
}

/** The "Matches in this document" jump list, driven by a `?q=` search query. */
function MatchesPanel(
  { indices, blockTexts, onJump }: {
    indices: number[]
    blockTexts: string[]
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
              <span className='rp-clamp-2'>{blockTexts[index]}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Floating "Save selection" action that appears near a text selection made
 * inside the reading pane, so a passage can be promoted to Evidence without
 * leaving the reader. Dismissed on scroll, Escape, or a click outside.
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

function ViewerSkeleton() {
  return (
    <div className='rp-card p-5'>
      <Skeleton className='h-[55vh] w-full' />
    </div>
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

  const blocks = useMemo(() => {
    const joined = (content?.texts ?? []).map((t) => t.text).join('\n\n')
    return parseDocBlocks(joined)
  }, [content])
  const blockTexts = useMemo(() => blocks.map(blockPlainText), [blocks])

  const matchTerms = useMemo(() => queryTerms(qParam), [qParam])
  const matchIndices = useMemo(() => {
    if (matchTerms.length === 0) return []
    return blockTexts
      .map((text, index) => ({ normalised: normalise(text), index }))
      .filter(({ normalised }) => matchTerms.some((term) => normalised.includes(term)))
      .map(({ index }) => index)
  }, [blockTexts, matchTerms])

  function jumpToBlock(index: number) {
    document.getElementById(`doc-block-${index}`)?.scrollIntoView({
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

  const topicLabel = (topicId: string) => config.topics.find((topic) => topic.id === topicId)?.label

  return (
    <main className='rp-shell py-8'>
      <Link
        to={`/t/${config.slug}/library`}
        className='text-sm font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
      >
        &larr; Back to library
      </Link>

      <div className='mt-4'>
        {isLoading ? <ViewerSkeleton /> : null}

        {isError && notFound
          ? (
            <EmptyState
              title='This document does not exist'
              description='It may have been removed, or the link is out of date.'
            >
              <Link to={`/t/${config.slug}/library`} className='rp-btn rp-btn-primary'>
                Back to library
              </Link>
            </EmptyState>
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
              <ResourceHeader
                slug={config.slug}
                resource={resource}
                originUrl={content?.originUrl}
                topicLabel={topicLabel}
                organisation={config.branding.organisation}
              />

              <div className='mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_368px] 2xl:grid-cols-[minmax(0,1fr)_408px]'>
                <div className='min-w-0 space-y-6'>
                  <div className='relative' ref={contentRef} onMouseUp={handleContentMouseUp}>
                    {contentLoading ? <ViewerSkeleton /> : content
                      ? (
                        <div className='rp-card p-4 sm:p-5'>
                          <ResourceViewer
                            slug={config.slug}
                            content={content}
                            blocks={blocks}
                            passage={passage}
                            page={page}
                            flashIndex={flashIndex}
                            hasTextMatches={matchIndices.length > 0}
                          />
                        </div>
                      )
                      : (
                        <EmptyState
                          title='This document cannot be displayed'
                          description='The full content is unavailable for this resource right now.'
                        />
                      )}
                  </div>

                  <ResourceContext resource={resource} />
                </div>

                <aside className='space-y-5 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto lg:pr-1'>
                  <MatchesPanel
                    indices={matchIndices}
                    blockTexts={blockTexts}
                    onJump={jumpToBlock}
                  />
                  <DocumentChat slug={config.slug} resource={resource} />
                  <RecommendationsRail slug={config.slug} resource={resource} />
                </aside>
              </div>
            </>
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
