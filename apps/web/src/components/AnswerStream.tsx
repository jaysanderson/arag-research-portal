import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AskEvent, Citation, ScoredResource } from '@research-portal/core'
import { type AskRequest, streamAsk } from '../api/client.ts'
import { AnswerJourney } from './AnswerJourney.tsx'

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

export interface ContextJourneyProps {
  slug: string
  sources: ScoredResource[]
  /**
   * The question the answer was built from. Shown on the journey's opening
   * screen and used to ask each source how it relates. Optional so existing
   * callers keep working; the walk still runs without it.
   */
  query?: string
}

/**
 * "Journey through the context" - the quiet trigger that opens the cinematic
 * walk through the sources behind an answer. Standalone and reusable so
 * Search/Ask, the assistant and the agentic pipeline all offer the same
 * experience from the same one-line call.
 */
export function ContextJourney({ slug, sources, query = '' }: ContextJourneyProps) {
  const [isOpen, setIsOpen] = useState(false)

  const citedIds = useMemo(
    () => sources.filter((source) => source.citedCount > 0).map((source) => source.id),
    [sources],
  )

  if (sources.length === 0) return null

  return (
    <>
      <button
        type='button'
        onClick={() => setIsOpen(true)}
        aria-haspopup='dialog'
        className='rp-chip group font-semibold'
      >
        <svg
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.6'
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'
          className='h-3.5 w-3.5 shrink-0 transition-transform duration-300 group-hover:rotate-45'
          style={{ color: 'var(--rp-accent)' }}
        >
          <circle cx='12' cy='12' r='9' />
          <path d='M15.2 8.8l-1.6 4.4-4.4 1.6 1.6-4.4z' />
        </svg>
        Journey through the context
        <span className='rounded-[4px] bg-surface-2 px-1.5 py-0.5 text-[10px] tabular-nums text-ink-3'>
          {Math.min(sources.length, 8)}
        </span>
      </button>

      <AnswerJourney
        open={isOpen}
        onClose={() => setIsOpen(false)}
        slug={slug}
        query={query}
        sources={sources}
        citedIds={citedIds}
      />
    </>
  )
}

/**
 * Self-contained streamed-answer view: input state machine (idle / streaming
 * / done / error), a tiny inline markdown renderer, numbered source chips
 * that deep-link into the resource view (with a secondary scroll affordance
 * when a matching result is on the page), a "journey through the context"
 * trigger, and a usage line. Reused by SearchPage (whole-corpus asks) and
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

  /** Sources with live citation counts folded in - what the journey walks. */
  const citedSources = useMemo(
    () =>
      sources.map((resource) => ({
        ...resource,
        citedCount: citations.filter((citation) => citation.resourceId === resource.id).length,
      })),
    [sources, citations],
  )

  useEffect(() => {
    if (citedSources.length === 0) return
    onSources?.(citedSources)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citedSources])

  if (status === 'idle') return null

  function scrollToResource(resourceId: string) {
    const el = document.getElementById(`result-${resourceId}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className='rp-card p-5'>
      <div className='flex items-center gap-2'>
        <span
          className='h-2 w-2 shrink-0 rounded-full'
          style={{ backgroundColor: 'var(--rp-accent)' }}
          aria-hidden='true'
        />
        <p className='rp-eyebrow text-ink-3'>
          AI answer
        </p>
      </div>

      <div className='rp-prose mt-3 space-y-3 text-sm text-ink'>
        {text.length > 0
          ? renderAnswerText(text)
          : status === 'streaming'
          ? <p className='text-ink-3'>Thinking&hellip;</p>
          : null}
        {status === 'streaming'
          ? (
            <span
              className='inline-block h-4 w-1.5 animate-pulse bg-[var(--rp-ink-3)] align-text-bottom'
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
                      className='rp-focus inline-flex items-center gap-1.5 rounded-[6px] border border-line bg-[var(--rp-surface-2)] px-2 py-1 text-xs font-medium text-[var(--rp-ink-2)] transition-colors duration-150 hover:bg-[var(--rp-surface-3)] hover:text-[var(--rp-ink)]'
                    >
                      <span
                        className='flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-[10px] font-semibold tabular-nums text-white'
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
                          className='rp-focus flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] text-xs text-[var(--rp-ink-3)] transition-colors duration-150 hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
                        >
                          &darr;
                        </button>
                      )
                      : null}
                  </div>
                )
              })}
            </div>
            <p className='mt-2 text-xs text-ink-3'>
              {citations.length} {citations.length === 1 ? 'source' : 'sources'} cited
            </p>
          </>
        )
        : null}

      {errorMessage
        ? (
          <p className='mt-3 text-xs text-[var(--rp-bad-ink)]'>
            Answer unavailable right now - {errorMessage}
          </p>
        )
        : null}

      {usage
        ? (
          <p className='mt-3 text-xs text-ink-3'>
            {usage.inputTokens.toLocaleString()} in / {usage.outputTokens.toLocaleString()}{' '}
            out tokens{usage.totalSec !== undefined ? ` - ${usage.totalSec.toFixed(1)} s` : ''}
          </p>
        )
        : null}

      {status === 'done' && citedSources.length > 0
        ? (
          <div className='mt-4 border-t border-line pt-3.5'>
            <ContextJourney slug={slug} sources={citedSources} query={request.query} />
          </div>
        )
        : null}
    </div>
  )
}
