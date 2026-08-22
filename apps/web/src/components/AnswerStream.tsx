import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AskEvent, Citation, ScoredResource } from '@research-portal/core'
import { type AskRequest, streamAsk } from '../api/client.ts'

type Status = 'idle' | 'streaming' | 'done' | 'error'
type UsageEvent = Extract<AskEvent, { type: 'usage' }>

export interface AnswerStreamProps {
  slug: string
  request: AskRequest
  /**
   * Fires whenever the streamed answer's source list (or citation counts on
   * it) change, so a parent results list can show "Cited n" badges without
   * re-implementing the stream itself.
   */
  onSources?: (resources: ScoredResource[]) => void
}

/**
 * Deep link into the resource view for a citation, carrying the matched
 * passage (truncated) so the resource page can highlight/scroll to it. The
 * passage param is omitted entirely when there's no matched passage.
 */
export function citationHref(
  slug: string,
  resourceId: string,
  matchedPassage: string | undefined,
): string {
  const query = matchedPassage ? `?passage=${encodeURIComponent(matchedPassage.slice(0, 300))}` : ''
  return `/t/${slug}/library/${resourceId}${query}`
}

/** Renders `**bold**` spans within a single line/paragraph of streamed text. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={`${keyPrefix}-${index}`}>{part.slice(2, -2)}</strong>
    }
    return <span key={`${keyPrefix}-${index}`}>{part}</span>
  })
}

/** Minimal markdown-ish renderer: \n\n paragraphs, **bold**, and "- " lists. */
function renderAnswerText(text: string): ReactNode[] {
  const blocks = text.split(/\n{2,}/)
  return blocks.map((block, blockIndex) => {
    const lines = block.split('\n').filter((line) => line.trim().length > 0)
    const isList = lines.length > 0 && lines.every((line) => line.trim().startsWith('- '))

    if (isList) {
      return (
        <ul key={blockIndex} className='list-disc space-y-1 pl-5'>
          {lines.map((line, lineIndex) => (
            <li key={lineIndex}>
              {renderInline(line.trim().slice(2), `${blockIndex}-${lineIndex}`)}
            </li>
          ))}
        </ul>
      )
    }

    if (block.trim().length === 0) return null

    return (
      <p key={blockIndex} className='leading-relaxed'>
        {renderInline(block, String(blockIndex))}
      </p>
    )
  })
}

/**
 * Tracks which `#result-<id>` elements currently exist on the page for the
 * given resource ids. The results list is a sibling component that can mount
 * (or finish loading) after citations have already arrived, so this watches
 * the DOM rather than trusting a one-off lookup.
 */
function useExistingResultIds(ids: string[]): Set<string> {
  const [existing, setExisting] = useState<Set<string>>(new Set())
  const idsKey = ids.join(',')

  useEffect(() => {
    const watched = idsKey.length > 0 ? idsKey.split(',') : []

    function recompute() {
      const next = new Set<string>()
      for (const id of watched) {
        if (document.getElementById(`result-${id}`)) next.add(id)
      }
      setExisting((prev) => {
        if (prev.size === next.size && [...prev].every((id) => next.has(id))) return prev
        return next
      })
    }

    recompute()
    if (watched.length === 0) return

    const observer = new MutationObserver(recompute)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [idsKey])

  return existing
}

function RelevanceMeter({ relevance, label }: { relevance: number; label: string }) {
  const percent = Math.round(relevance * 100)
  return (
    <div className='flex items-center gap-2'>
      <div
        className='h-1.5 w-24 overflow-hidden rounded-full bg-neutral-200'
        role='progressbar'
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Relevance of ${label}`}
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

export interface ContextJourneyProps {
  slug: string
  sources: ScoredResource[]
}

/**
 * "Journey through the context" - a subtle toggle that expands a stepper
 * over the sources behind an answer: a step counter, previous/next controls,
 * and the current source's title (deep-linked), relevance and matched
 * passage. Left/right arrow keys step through sources while the panel has
 * focus. Standalone and reusable so Search/Ask, the assistant and the
 * agentic pipeline can all show the same walk.
 */
export function ContextJourney({ slug, sources }: ContextJourneyProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [stepIndex, setStepIndex] = useState(0)

  if (sources.length === 0) return null

  const clampedIndex = Math.min(stepIndex, sources.length - 1)
  const current = sources[clampedIndex]

  function goTo(index: number) {
    setStepIndex(Math.max(0, Math.min(sources.length - 1, index)))
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      goTo(clampedIndex - 1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      goTo(clampedIndex + 1)
    }
  }

  return (
    <div>
      <button
        type='button'
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        className='inline-flex items-center gap-1.5 text-xs font-medium text-neutral-500 transition-colors duration-150 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
        style={{ outlineColor: 'var(--rp-accent)' }}
      >
        <svg
          className={`h-3 w-3 shrink-0 transition-transform duration-150 ${
            isOpen ? 'rotate-90' : ''
          }`}
          viewBox='0 0 20 20'
          fill='currentColor'
          aria-hidden='true'
        >
          <path
            fillRule='evenodd'
            d='M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z'
            clipRule='evenodd'
          />
        </svg>
        Journey through the context
      </button>

      {isOpen && current
        ? (
          <div
            role='group'
            aria-label='Journey through the context'
            tabIndex={0}
            onKeyDown={handleKeyDown}
            className='mt-3 rounded-2xl border border-neutral-200 bg-neutral-50 p-4 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
            style={{ outlineColor: 'var(--rp-accent)' }}
          >
            <div className='flex items-center justify-between'>
              <p className='text-xs font-medium text-neutral-500'>
                Chunk {clampedIndex + 1} of {sources.length}
              </p>
              <div className='flex items-center gap-1.5'>
                <button
                  type='button'
                  onClick={() => goTo(clampedIndex - 1)}
                  disabled={clampedIndex === 0}
                  aria-label='Previous source'
                  className='flex h-6 w-6 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-600 transition-colors duration-150 hover:text-neutral-900 disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
                  style={{ outlineColor: 'var(--rp-accent)' }}
                >
                  &lsaquo;
                </button>
                <button
                  type='button'
                  onClick={() => goTo(clampedIndex + 1)}
                  disabled={clampedIndex === sources.length - 1}
                  aria-label='Next source'
                  className='flex h-6 w-6 items-center justify-center rounded-full border border-neutral-200 bg-white text-neutral-600 transition-colors duration-150 hover:text-neutral-900 disabled:opacity-30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
                  style={{ outlineColor: 'var(--rp-accent)' }}
                >
                  &rsaquo;
                </button>
              </div>
            </div>

            <Link
              to={citationHref(slug, current.id, current.matchedPassage)}
              className='mt-2 block text-sm font-semibold text-neutral-900 hover:underline'
            >
              {current.title}
            </Link>

            <div className='mt-2'>
              <RelevanceMeter relevance={current.relevance} label={current.title} />
            </div>

            {current.matchedPassage
              ? (
                <blockquote
                  className='mt-3 border-l-2 pl-4 text-sm italic leading-relaxed text-neutral-700'
                  style={{ borderColor: 'var(--rp-accent)' }}
                >
                  &ldquo;{current.matchedPassage}&rdquo;
                </blockquote>
              )
              : null}
          </div>
        )
        : null}
    </div>
  )
}

/**
 * Self-contained streamed-answer view: input state machine (idle / streaming
 * / done / error), a tiny inline markdown renderer, numbered source chips
 * that deep-link into the resource view (with a secondary scroll affordance
 * when a matching result is on the page), a "journey through the context"
 * stepper, and a usage line. Reused by SearchPage (whole-corpus asks) and
 * ResourceDetailPage (single-document asks via `resourceId`).
 */
export function AnswerStream({ slug, request, onSources }: AnswerStreamProps) {
  const [status, setStatus] = useState<Status>('idle')
  const [text, setText] = useState('')
  const [sources, setSources] = useState<ScoredResource[]>([])
  const [citations, setCitations] = useState<Citation[]>([])
  const [usage, setUsage] = useState<UsageEvent | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const key = `${slug}|${request.query}|${request.resourceId ?? ''}|${
    (request.topicIds ?? []).join(',')
  }`

  const existingResultIds = useExistingResultIds(citations.map((citation) => citation.resourceId))

  useEffect(() => {
    abortRef.current?.abort()

    if (request.query.trim().length === 0) {
      setStatus('idle')
      setText('')
      setSources([])
      setCitations([])
      setUsage(null)
      setErrorMessage(null)
      return
    }

    const controller = new AbortController()
    abortRef.current = controller
    setStatus('streaming')
    setText('')
    setSources([])
    setCitations([])
    setUsage(null)
    setErrorMessage(null)

    streamAsk(slug, request, (event: AskEvent) => {
      switch (event.type) {
        case 'sources':
          setSources(event.resources)
          break
        case 'delta':
          setText((prev) => prev + event.text)
          break
        case 'citation':
          setCitations((prev) => [...prev, event.citation])
          break
        case 'usage':
          setUsage(event)
          break
        case 'done':
          setStatus('done')
          break
        case 'error':
          setErrorMessage(event.message)
          setStatus('error')
          break
        case 'stage':
          break
      }
    }, controller.signal).catch((err: unknown) => {
      if (controller.signal.aborted) return
      setErrorMessage(err instanceof Error ? err.message : 'The answer service is unavailable')
      setStatus('error')
    })

    return () => {
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    if (sources.length === 0) return
    const merged = sources.map((resource) => ({
      ...resource,
      citedCount: citations.filter((citation) => citation.resourceId === resource.id).length,
    }))
    onSources?.(merged)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, citations])

  if (status === 'idle') return null

  function scrollToResource(resourceId: string) {
    const el = document.getElementById(`result-${resourceId}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
      <div className='flex items-center gap-2'>
        <span
          className='h-2 w-2 shrink-0 rounded-full'
          style={{ backgroundColor: 'var(--rp-accent)' }}
          aria-hidden='true'
        />
        <p className='text-xs font-semibold uppercase tracking-wide text-neutral-500'>
          AI answer
        </p>
      </div>

      <div className='mt-3 space-y-3 text-sm text-neutral-800'>
        {text.length > 0
          ? renderAnswerText(text)
          : status === 'streaming'
          ? <p className='text-neutral-400'>Thinking&hellip;</p>
          : null}
        {status === 'streaming'
          ? (
            <span
              className='inline-block h-4 w-1.5 animate-pulse bg-neutral-400 align-text-bottom'
              aria-hidden='true'
            />
          )
          : null}
      </div>

      {citations.length > 0
        ? (
          <>
            <div className='mt-4 flex flex-wrap items-center gap-1.5'>
              {citations.map((citation) => {
                const matchedPassage = sources.find((resource) =>
                  resource.id === citation.resourceId
                )?.matchedPassage
                return (
                  <div key={citation.index} className='inline-flex items-center gap-1'>
                    <Link
                      to={citationHref(slug, citation.resourceId, matchedPassage)}
                      className='inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-xs font-medium text-neutral-700 transition-colors duration-150 hover:border-neutral-300 hover:text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
                      style={{ outlineColor: 'var(--rp-accent)' }}
                    >
                      <span
                        className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white'
                        style={{ backgroundColor: 'var(--rp-primary)' }}
                      >
                        {citation.index}
                      </span>
                      <span className='rp-clamp-2 max-w-[14rem] text-left'>{citation.title}</span>
                    </Link>
                    {existingResultIds.has(citation.resourceId)
                      ? (
                        <button
                          type='button'
                          onClick={() => scrollToResource(citation.resourceId)}
                          aria-label={`Scroll to ${citation.title} in the results below`}
                          title='Scroll to this result'
                          className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs text-neutral-400 transition-colors duration-150 hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
                          style={{ outlineColor: 'var(--rp-accent)' }}
                        >
                          &darr;
                        </button>
                      )
                      : null}
                  </div>
                )
              })}
            </div>
            <p className='mt-2 text-xs text-neutral-500'>
              {citations.length} {citations.length === 1 ? 'source' : 'sources'} cited
            </p>
          </>
        )
        : null}

      {errorMessage
        ? (
          <p className='mt-3 text-xs text-neutral-400'>
            Answer unavailable right now - {errorMessage}
          </p>
        )
        : null}

      {usage
        ? (
          <p className='mt-3 text-xs text-neutral-400'>
            {usage.inputTokens.toLocaleString()} in / {usage.outputTokens.toLocaleString()}{' '}
            out tokens{usage.totalSec !== undefined ? ` - ${usage.totalSec.toFixed(1)} s` : ''}
          </p>
        )
        : null}

      {status === 'done' && sources.length > 0
        ? (
          <div className='mt-4 border-t border-neutral-100 pt-3'>
            <ContextJourney slug={slug} sources={sources} />
          </div>
        )
        : null}
    </div>
  )
}
