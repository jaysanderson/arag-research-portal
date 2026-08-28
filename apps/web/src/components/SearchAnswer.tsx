import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AskEvent, Citation, ScoredResource } from '@research-portal/core'
import { ApiError, streamAsk } from '../api/client.ts'
import { citationHref } from './AnswerStream.tsx'
import { ErrorCard, LiveStatus, Skeleton } from './ui.tsx'

/**
 * Matches `RATE_LIMIT_MESSAGE` in apps/api/src/rate-limit.ts word for word.
 * That module is server-only and never bundled into the web client, so the
 * copy is duplicated here rather than imported - keep the two in sync by eye
 * if the server copy changes.
 */
const RATE_LIMIT_MESSAGE =
  'You are asking faster than the portal can answer - please wait a moment and try again.'

/** Matches AssistantPage's own stage copy, duplicated here (not exported there). */
const STAGE_LABELS: Record<string, string> = {
  preprocessing: 'Preparing your question…',
  retrieval: 'Retrieving sources…',
  generating: 'Generating…',
  validating: 'Checking the answer…',
}

type Status = 'idle' | 'streaming' | 'done' | 'error'

export interface SearchAnswerResult {
  citations: Citation[]
  sources: ScoredResource[]
}

export interface SearchAnswerProps {
  slug: string
  /** The submitted (not draft) search query - a stream starts only when this changes. */
  query: string
  /**
   * Fires whenever the streamed answer's citations or sources change -
   * including back to empty arrays the moment a new query starts - so the
   * result cards above/below can show "Cited [n]" badges and power the
   * Resources/Citations toggle without re-implementing the stream.
   */
  onResult?: (result: SearchAnswerResult) => void
}

/**
 * Replaces `[n]` markers in a plain-text run with superscript, accent-
 * coloured links to the matching citation's deep link - the same treatment
 * AssistantPage gives its own streamed answers. Duplicated here (a small
 * pure function, not exported there) so this panel's prose matches it.
 */
function renderCitationMarkers(
  text: string,
  citations: Citation[],
  sources: ScoredResource[],
  slug: string,
  keyPrefix: string,
): ReactNode[] {
  const segments = text.split(/(\[\d+\])/g)
  return segments.map((segment, index) => {
    const match = /^\[(\d+)\]$/.exec(segment)
    const citationIndex = match?.[1] ? Number(match[1]) : null
    const citation = citationIndex === null
      ? undefined
      : citations.find((item) => item.index === citationIndex)

    if (citation) {
      const matchedPassage = sources.find((source) => source.id === citation.resourceId)
        ?.matchedPassage
      return (
        <sup key={`${keyPrefix}-${index}`}>
          <Link
            to={citationHref(slug, citation.resourceId, matchedPassage)}
            className='font-semibold no-underline'
            style={{ color: 'var(--rp-accent)' }}
            title={`Source ${citationIndex} - ${citation.title}`}
          >
            [{citationIndex}]
          </Link>
        </sup>
      )
    }
    return <span key={`${keyPrefix}-${index}`}>{segment}</span>
  })
}

function renderInline(
  text: string,
  citations: Citation[],
  sources: ScoredResource[],
  slug: string,
): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.flatMap((part, index): ReactNode[] =>
    part.startsWith('**') && part.endsWith('**') && part.length > 4
      ? [<strong key={index}>{part.slice(2, -2)}</strong>]
      : renderCitationMarkers(part, citations, sources, slug, String(index))
  )
}

/** Minimal markdown-ish renderer: \n\n paragraphs, **bold**, "- " lists, and [n] markers. */
function renderAnswer(
  text: string,
  citations: Citation[],
  sources: ScoredResource[],
  slug: string,
): ReactNode {
  const blocks = text.split(/\n{2,}/).filter((block) => block.trim().length > 0)
  return (
    <div className='space-y-3'>
      {blocks.map((block, blockIndex) => {
        const lines = block.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
        const isList = lines.length > 0 && lines.every((line) => line.startsWith('- '))
        if (isList) {
          return (
            <ul key={blockIndex} className='list-disc space-y-1 pl-5'>
              {lines.map((line, lineIndex) => (
                <li key={lineIndex} className='text-sm leading-relaxed text-ink'>
                  {renderInline(line.slice(2), citations, sources, slug)}
                </li>
              ))}
            </ul>
          )
        }
        return (
          <p key={blockIndex} className='text-sm leading-relaxed text-ink'>
            {renderInline(block.trim(), citations, sources, slug)}
          </p>
        )
      })}
    </div>
  )
}

/** Three shimmering lines while the answer is forming and no text has arrived yet. */
function AnswerSkeleton() {
  return (
    <div className='space-y-2' aria-hidden='true'>
      <Skeleton className='h-4 w-full' />
      <Skeleton className='h-4 w-full' />
      <Skeleton className='h-4 w-2/3' />
    </div>
  )
}

/**
 * The AI Answer panel restored to the search results page: a streamed,
 * cited answer for the same query the results below are for. Collapsible,
 * honest about refusal (the portal's "no direct evidence" pattern rather
 * than a fake answer), surfaces rate-limiting plainly, and always offers a
 * path to continue the same question in the full Assistant.
 *
 * Deliberately its own small stream state machine rather than reusing
 * `AnswerStream` - this panel needs to apply the deterministically
 * citation-bound `done.text` (so inline `[n]` markers render), branch on
 * `refused`, and turn a 429 into the portal's rate-limit copy, none of
 * which the shared component currently does. Reports citations/sources up
 * via `onResult` so SearchPage can badge result cards and power the
 * Resources/Citations toggle without duplicating the stream itself.
 */
export function SearchAnswer({ slug, query, onResult }: SearchAnswerProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [text, setText] = useState('')
  const [sources, setSources] = useState<ScoredResource[]>([])
  const [citations, setCitations] = useState<Citation[]>([])
  const [refused, setRefused] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [stageLabel, setStageLabel] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const [retryToken, setRetryToken] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  const trimmed = query.trim()
  const key = `${slug}|${trimmed}|${retryToken}`

  // Stream (or reset) whenever the submitted query, tenant or retry token
  // changes. Aborts any in-flight stream first - covers both a genuinely new
  // query and unmount, since the effect cleanup runs the same abort.
  useEffect(() => {
    abortRef.current?.abort()

    if (trimmed.length === 0) {
      setStatus('idle')
      setText('')
      setSources([])
      setCitations([])
      setRefused(false)
      setErrorMessage(null)
      setStageLabel(null)
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setStatus('streaming')
    setText('')
    setSources([])
    setCitations([])
    setRefused(false)
    setErrorMessage(null)
    setStageLabel('Retrieving sources…')

    streamAsk(slug, { query: trimmed }, (event: AskEvent) => {
      switch (event.type) {
        case 'stage':
          setStageLabel(event.status === 'started' ? STAGE_LABELS[event.stage] ?? null : null)
          break
        case 'sources':
          setSources(event.resources)
          break
        case 'delta':
          setText((prev) => prev + event.text)
          break
        case 'citation':
          setCitations((prev) => [...prev, event.citation])
          break
        case 'done':
          setStageLabel(null)
          // The deterministically citation-bound text (server-spliced [n]
          // markers) replaces the streamed accumulation, same as
          // AssistantPage - falls back to the streamed text when absent
          // (a refusal carries no citations to bind).
          if (event.text !== undefined) setText(event.text)
          setRefused(event.refused ?? false)
          setStatus('done')
          break
        case 'error':
          setStageLabel(null)
          setErrorMessage(event.message)
          setStatus('error')
          break
        default:
          break
      }
    }, controller.signal).catch((err: unknown) => {
      if (controller.signal.aborted) return
      setStageLabel(null)
      setErrorMessage(
        err instanceof ApiError && err.status === 429
          ? RATE_LIMIT_MESSAGE
          : err instanceof Error
          ? err.message
          : 'The answer service is unavailable.',
      )
      setStatus('error')
    })

    return () => {
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    onResult?.({ citations, sources })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citations, sources])

  if (status === 'idle') return null

  function retry() {
    setRetryToken((prev) => prev + 1)
  }

  const liveMessage = status === 'streaming'
    ? (stageLabel ?? 'Answer in progress')
    : status === 'done'
    ? (refused ? 'No direct evidence found' : 'Answer complete')
    : status === 'error'
    ? 'Answer unavailable'
    : ''

  const headerSummary = status === 'streaming'
    ? (stageLabel ?? 'Thinking…')
    : status === 'error'
    ? 'Unavailable'
    : refused
    ? 'No direct evidence found'
    : `${citations.length} ${citations.length === 1 ? 'citation' : 'citations'}`

  const askHref = `/t/${slug}/assistant?ask=${encodeURIComponent(trimmed)}`

  return (
    <section className='rp-card p-5' aria-label='AI answer'>
      <LiveStatus message={liveMessage} />
      <div className='flex items-center justify-between gap-3'>
        <div className='flex min-w-0 items-center gap-2'>
          <span
            className='h-2 w-2 shrink-0 rounded-full'
            style={{ backgroundColor: 'var(--rp-accent)' }}
            aria-hidden='true'
          />
          <p className='rp-eyebrow shrink-0 text-ink-3'>AI answer</p>
          {collapsed
            ? <p className='truncate text-xs text-ink-3'>&middot; {headerSummary}</p>
            : null}
        </div>
        <button
          type='button'
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          aria-controls='search-answer-body'
          className='rp-focus shrink-0 rounded-[4px] px-1 text-xs font-medium text-[var(--rp-ink-3)] transition-colors duration-150 hover:text-[var(--rp-ink)]'
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>

      {!collapsed
        ? (
          <div id='search-answer-body' className='mt-3'>
            {status === 'error'
              ? (
                <ErrorCard
                  message={errorMessage ?? 'The answer service is unavailable.'}
                  onRetry={retry}
                />
              )
              : status === 'streaming' && text.length === 0
              ? <AnswerSkeleton />
              : (
                <>
                  {refused
                    ? (
                      <div className='mb-3'>
                        <span className='rp-badge rp-badge-quiet'>No direct evidence found</span>
                      </div>
                    )
                    : null}

                  {text.length > 0
                    ? (
                      <div className='rp-prose text-sm text-ink'>
                        {renderAnswer(text, citations, sources, slug)}
                      </div>
                    )
                    : null}

                  {status === 'streaming'
                    ? (
                      <span
                        className='mt-1 inline-block h-4 w-1.5 animate-pulse bg-[var(--rp-ink-3)] align-text-bottom'
                        aria-hidden='true'
                      />
                    )
                    : null}

                  {status === 'done' && !refused
                    ? (
                      <p className='mt-3 text-xs text-ink-3'>
                        {citations.length} {citations.length === 1 ? 'source' : 'sources'} cited
                      </p>
                    )
                    : null}
                </>
              )}

            <div className='mt-4 flex justify-end border-t border-line pt-3'>
              <Link
                to={askHref}
                className='rp-chip inline-flex h-9 items-center gap-1.5 font-semibold sm:h-7'
              >
                Continue in Assistant
                <span aria-hidden='true'>&rarr;</span>
              </Link>
            </div>
          </div>
        )
        : null}
    </section>
  )
}
