import { type ReactNode, useEffect, useRef, useState } from 'react'
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
 * Self-contained streamed-answer view: input state machine (idle / streaming
 * / done / error), a tiny inline markdown renderer, numbered source chips
 * that scroll to a matching `#result-<id>` element, and a usage line. Reused
 * by SearchPage (whole-corpus asks) and ResourceDetailPage (single-document
 * asks via `resourceId`).
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
            <div className='mt-4 flex flex-wrap items-center gap-2'>
              {citations.map((citation) => (
                <button
                  key={citation.index}
                  type='button'
                  onClick={() => scrollToResource(citation.resourceId)}
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
                </button>
              ))}
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
    </div>
  )
}
