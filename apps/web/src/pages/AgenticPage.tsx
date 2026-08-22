import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { AskEvent, AskStage, Citation, ScoredResource } from '@research-portal/core'
import { getSuggestedQuestions, streamAsk } from '../api/client.ts'
import { citationHref, ContextJourney } from '../components/AnswerStream.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// Local types + localStorage trace history
// ---------------------------------------------------------------------------

type StageStatus = 'pending' | 'active' | 'complete'

type StageStatuses = Record<AskStage, StageStatus>

type Trace = {
  id: string
  question: string
  answerChars: number
  sourceCount: number
  tokens: { input: number; output: number } | null
  seconds: number | null
  when: number
}

const TRACE_CAP = 25

function traceKey(slug: string): string {
  return `rp-traces-${slug}`
}

function loadTraces(slug: string): Trace[] {
  try {
    const raw = localStorage.getItem(traceKey(slug))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as Trace[]) : []
  } catch {
    return []
  }
}

function saveTraces(slug: string, traces: Trace[]) {
  try {
    localStorage.setItem(traceKey(slug), JSON.stringify(traces.slice(0, TRACE_CAP)))
  } catch {
    // localStorage unavailable or full - trace history simply won't persist this run.
  }
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function relativeAge(timestamp: number): string {
  const diffMs = Date.now() - timestamp
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

const STAGES: { key: AskStage; label: string }[] = [
  { key: 'preprocessing', label: 'Preprocess' },
  { key: 'retrieval', label: 'Retrieve' },
  { key: 'generating', label: 'Generate' },
  { key: 'validating', label: 'Validate' },
]

const IDLE_STAGES: StageStatuses = {
  preprocessing: 'pending',
  retrieval: 'pending',
  generating: 'pending',
  validating: 'pending',
}

// ---------------------------------------------------------------------------
// Minimal markdown-ish renderer - no libraries. Supports paragraphs split on
// blank lines, "### " headings, "- " bullet lists and **bold** spans.
// ---------------------------------------------------------------------------

function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return parts.map((part, index) =>
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={index}>{part.slice(2, -2)}</strong>
      : <span key={index}>{part}</span>
  )
}

function renderMarkdown(text: string): ReactNode {
  const blocks = text.split(/\n{2,}/).filter((block) => block.trim().length > 0)
  return (
    <div className='space-y-3'>
      {blocks.map((block, index) => {
        const trimmed = block.trim()
        if (trimmed.startsWith('### ')) {
          return (
            <h3 key={index} className='text-sm font-semibold text-ink'>
              {renderInline(trimmed.slice(4))}
            </h3>
          )
        }
        const lines = trimmed.split('\n').map((line) => line.trim())
        const isList = lines.length > 0 && lines.every((line) => line.startsWith('- '))
        if (isList) {
          return (
            <ul key={index} className='list-disc space-y-1 pl-5'>
              {lines.map((line, lineIndex) => (
                <li key={lineIndex} className='text-sm leading-relaxed text-ink-2'>
                  {renderInline(line.slice(2))}
                </li>
              ))}
            </ul>
          )
        }
        return (
          <p key={index} className='text-sm leading-relaxed text-ink-2'>
            {renderInline(trimmed)}
          </p>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pipeline rail
// ---------------------------------------------------------------------------

function StageDot({ status }: { status: StageStatus }) {
  if (status === 'complete') {
    return (
      <span
        className='flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--rp-ok-ink)] text-[10px] font-bold text-white'
        aria-hidden='true'
      >
        ✓
      </span>
    )
  }
  if (status === 'active') {
    return (
      <span className='flex h-5 w-5 shrink-0 items-center justify-center' aria-hidden='true'>
        <span
          className='h-3 w-3 animate-pulse rounded-full'
          style={{ backgroundColor: 'var(--rp-accent)' }}
        />
      </span>
    )
  }
  return (
    <span
      className='flex h-5 w-5 shrink-0 items-center justify-center'
      aria-hidden='true'
    >
      <span className='h-3 w-3 rounded-full border-2 border-line bg-surface' />
    </span>
  )
}

function PipelineRail({
  statuses,
  sources,
  usage,
}: {
  statuses: StageStatuses
  sources: ScoredResource[]
  usage: {
    inputTokens: number
    outputTokens: number
    firstChunkSec?: number
    totalSec?: number
  } | null
}) {
  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-5 shadow-sm'>
      <h2 className='text-sm font-semibold text-ink'>Pipeline</h2>
      <ol className='mt-4 space-y-0'>
        {STAGES.map((stage, index) => {
          const status = statuses[stage.key]
          const isLast = index === STAGES.length - 1
          return (
            <li key={stage.key} className='flex gap-3'>
              <div className='flex flex-col items-center'>
                <StageDot status={status} />
                {!isLast
                  ? (
                    <span
                      className={`mt-0.5 w-px flex-1 ${
                        status === 'complete' ? 'bg-[var(--rp-ok-line)]' : 'bg-surface-3'
                      }`}
                      aria-hidden='true'
                    />
                  )
                  : null}
              </div>
              <div className='pb-5'>
                <p
                  className={`text-sm font-medium ${
                    status === 'pending' ? 'text-ink-3' : 'text-ink'
                  }`}
                >
                  {stage.label}
                </p>

                {stage.key === 'retrieval' && sources.length > 0
                  ? (
                    <div className='mt-2 space-y-2'>
                      {sources.slice(0, 6).map((resource) => (
                        <div
                          key={resource.id}
                          className='rounded-lg border border-line bg-surface-2 px-2.5 py-2'
                        >
                          <p className='rp-clamp-2 text-xs font-medium text-ink-2'>
                            {resource.title}
                          </p>
                          <div
                            className='mt-1 h-1 overflow-hidden rounded-full bg-surface-3'
                            role='progressbar'
                            aria-valuenow={Math.round(resource.relevance * 100)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`Relevance of ${resource.title}`}
                          >
                            <div
                              className='h-full rounded-full'
                              style={{
                                width: `${Math.round(resource.relevance * 100)}%`,
                                backgroundColor: 'var(--rp-accent)',
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                  : null}

                {stage.key === 'generating' && usage
                  ? (
                    <dl className='mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-ink-3'>
                      <dt>Input tokens</dt>
                      <dd className='text-right font-medium text-ink-2'>
                        {usage.inputTokens}
                      </dd>
                      <dt>Output tokens</dt>
                      <dd className='text-right font-medium text-ink-2'>
                        {usage.outputTokens}
                      </dd>
                      {usage.firstChunkSec !== undefined
                        ? (
                          <>
                            <dt>First chunk</dt>
                            <dd className='text-right font-medium text-ink-2'>
                              {usage.firstChunkSec.toFixed(2)}s
                            </dd>
                          </>
                        )
                        : null}
                      {usage.totalSec !== undefined
                        ? (
                          <>
                            <dt>Total time</dt>
                            <dd className='text-right font-medium text-ink-2'>
                              {usage.totalSec.toFixed(2)}s
                            </dd>
                          </>
                        )
                        : null}
                    </dl>
                  )
                  : null}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AgenticPage() {
  const { config } = useOutletContext<TenantOutletContext>()

  const [query, setQuery] = useState('')
  const [lastQuestion, setLastQuestion] = useState('')
  const [hasStarted, setHasStarted] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [answerText, setAnswerText] = useState('')
  const [citations, setCitations] = useState<Citation[]>([])
  const [sources, setSources] = useState<ScoredResource[]>([])
  const [stageStatuses, setStageStatuses] = useState<StageStatuses>(IDLE_STAGES)
  const [usage, setUsage] = useState<
    {
      inputTokens: number
      outputTokens: number
      firstChunkSec?: number
      totalSec?: number
    } | null
  >(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [traces, setTraces] = useState<Trace[]>(() => loadTraces(config.slug))

  const abortRef = useRef<AbortController | null>(null)
  const startedAtRef = useRef<number>(0)

  const { data: suggestions } = useQuery({
    queryKey: ['suggested-questions', config.slug],
    queryFn: () => getSuggestedQuestions(config.slug),
  })

  useEffect(() => {
    setTraces(loadTraces(config.slug))
  }, [config.slug])

  async function run(question: string) {
    const trimmed = question.trim()
    setLastQuestion(trimmed)
    if (trimmed.length === 0 || isRunning) return

    setQuery(trimmed)
    setHasStarted(true)
    setIsRunning(true)
    setAnswerText('')
    setCitations([])
    setSources([])
    setUsage(null)
    setErrorMessage(null)
    setStageStatuses(IDLE_STAGES)
    startedAtRef.current = Date.now()

    const controller = new AbortController()
    abortRef.current = controller

    let finalAnswer = ''
    let finalSourceCount = 0
    let finalUsage: { inputTokens: number; outputTokens: number; totalSec?: number } | null = null

    try {
      await streamAsk(
        config.slug,
        { query: trimmed },
        (event: AskEvent) => {
          switch (event.type) {
            case 'stage':
              setStageStatuses((prev) => ({
                ...prev,
                [event.stage]: event.status === 'started' ? 'active' : 'complete',
              }))
              break
            case 'sources':
              setSources(event.resources)
              finalSourceCount = event.resources.length
              break
            case 'delta':
              finalAnswer += event.text
              setAnswerText((prev) => prev + event.text)
              break
            case 'citation':
              setCitations((prev) =>
                prev.some((citation) => citation.index === event.citation.index)
                  ? prev
                  : [...prev, event.citation]
              )
              break
            case 'usage':
              finalUsage = {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                totalSec: event.totalSec,
              }
              setUsage({
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                firstChunkSec: event.firstChunkSec,
                totalSec: event.totalSec,
              })
              break
            case 'done':
              break
            case 'error':
              setErrorMessage(event.message)
              setStageStatuses((prev) => {
                const next = { ...prev }
                for (const stage of STAGES) {
                  if (next[stage.key] === 'active') next[stage.key] = 'pending'
                }
                return next
              })
              break
          }
        },
        controller.signal,
      )

      if (!controller.signal.aborted) {
        const elapsed = (Date.now() - startedAtRef.current) / 1000
        // Copy to a local so TS keeps the narrowing (finalUsage is assigned
        // inside the stream callback closure).
        const usage = finalUsage as {
          inputTokens: number
          outputTokens: number
          totalSec?: number
        } | null
        const trace: Trace = {
          id: makeId(),
          question: trimmed,
          answerChars: finalAnswer.length,
          sourceCount: finalSourceCount,
          tokens: usage ? { input: usage.inputTokens, output: usage.outputTokens } : null,
          seconds: usage?.totalSec ?? elapsed,
          when: Date.now(),
        }
        setTraces((prev) => {
          const next = [trace, ...prev].slice(0, TRACE_CAP)
          saveTraces(config.slug, next)
          return next
        })
      }
    } catch (thrown) {
      if (!controller.signal.aborted) {
        const message = thrown instanceof Error
          ? thrown.message
          : 'The pipeline could not complete this run.'
        setErrorMessage(message)
        setStageStatuses((prev) => {
          const next = { ...prev }
          for (const stage of STAGES) {
            if (next[stage.key] === 'active') next[stage.key] = 'pending'
          }
          return next
        })
      }
    } finally {
      setIsRunning(false)
      abortRef.current = null
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run(query)
  }

  const examples = suggestions?.slice(0, 4) ?? []

  return (
    <main aria-label='Agentic retrieval' className='mx-auto max-w-6xl px-4 py-8 sm:px-6'>
      <header>
        <h1 className='text-2xl font-semibold tracking-tight text-ink'>
          Agentic retrieval
        </h1>
        <p className='mt-1 text-sm text-ink-3'>
          Ask a complex question and watch the full retrieval pipeline - every signal below is live
          from the platform, nothing simulated.
        </p>
      </header>

      <form onSubmit={handleSubmit} className='mt-6'>
        <label htmlFor='agentic-query' className='sr-only'>
          Ask a complex question
        </label>
        <div className='flex items-center gap-2 rounded-[var(--rp-radius)] border border-line bg-surface p-1.5 shadow-sm'>
          <input
            id='agentic-query'
            type='text'
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={config.searchPlaceholder}
            disabled={isRunning}
            className='min-w-0 flex-1 rounded-[var(--rp-radius)] border-0 bg-transparent px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-60'
          />
          <button
            type='submit'
            disabled={isRunning || query.trim().length === 0}
            className='rp-btn rp-btn-primary shrink-0'
          >
            {isRunning ? 'Running…' : 'Run'}
          </button>
        </div>
      </form>

      {examples.length > 0
        ? (
          <div className='mt-3 flex flex-wrap gap-2'>
            {examples.map((question) => (
              <button
                key={question.id}
                type='button'
                disabled={isRunning}
                onClick={() => void run(question.text)}
                className='rp-chip h-9 disabled:opacity-50 sm:h-7'
              >
                {question.text}
              </button>
            ))}
          </div>
        )
        : null}

      {errorMessage
        ? (
          <div className='mt-6 rounded-[calc(var(--rp-radius)+4px)] border border-[var(--rp-bad-line)] bg-[var(--rp-bad-bg)] p-5'>
            <p className='text-sm font-medium text-[var(--rp-bad-ink)]'>
              The pipeline hit an error
            </p>
            <p className='mt-1 text-sm text-[var(--rp-bad-ink)]'>{errorMessage}</p>
          </div>
        )
        : null}

      {hasStarted
        ? (
          <div className='mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]'>
            <section
              aria-label='Answer'
              className='min-w-0 rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-6 shadow-sm'
            >
              {answerText.length > 0
                ? renderMarkdown(answerText)
                : isRunning
                ? <p className='text-sm text-ink-3'>Working on it…</p>
                : !errorMessage
                ? <p className='text-sm text-ink-3'>No answer yet.</p>
                : null}

              {isRunning && answerText.length > 0
                ? (
                  <span
                    className='ml-0.5 inline-block h-4 w-1.5 animate-pulse align-text-bottom'
                    style={{ backgroundColor: 'var(--rp-accent)' }}
                    aria-hidden='true'
                  />
                )
                : null}

              {citations.length > 0
                ? (
                  <div className='mt-4 border-t border-line pt-3'>
                    <p className='text-xs font-medium text-ink-3'>
                      Sources: {citations.length}
                    </p>
                    <div className='mt-2 flex flex-wrap gap-1.5'>
                      {citations.map((citation) => {
                        const matchedPassage = sources.find((resource) =>
                          resource.id === citation.resourceId
                        )?.matchedPassage
                        return (
                          <Link
                            key={citation.index}
                            to={citationHref(config.slug, citation.resourceId, matchedPassage)}
                            title={citation.title}
                            className='rp-chip'
                            style={{ outlineColor: 'var(--rp-accent)' }}
                          >
                            <span
                              className='inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold text-white'
                              style={{ backgroundColor: 'var(--rp-accent)' }}
                            >
                              {citation.index}
                            </span>
                            <span className='rp-clamp-2 max-w-[10rem]'>{citation.title}</span>
                          </Link>
                        )
                      })}
                    </div>
                  </div>
                )
                : null}

              {!isRunning && sources.length > 0
                ? (
                  <div className='mt-4 border-t border-line pt-3'>
                    <ContextJourney slug={config.slug} sources={sources} query={lastQuestion} />
                  </div>
                )
                : null}
            </section>

            <aside aria-label='Retrieval pipeline'>
              <PipelineRail statuses={stageStatuses} sources={sources} usage={usage} />
            </aside>
          </div>
        )
        : null}

      <section aria-label='Trace history' className='mt-10'>
        <h2 className='text-sm font-semibold uppercase tracking-wide text-ink-3'>
          Recent runs
        </h2>

        {traces.length === 0
          ? <p className='mt-3 text-sm text-ink-3'>No runs yet - ask a question above.</p>
          : (
            <div className='mt-3 overflow-x-auto rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface shadow-sm'>
              <table className='w-full min-w-[560px] text-left text-sm'>
                <thead>
                  <tr className='border-b border-line text-xs font-medium uppercase tracking-wide text-ink-3'>
                    <th scope='col' className='px-4 py-2.5 font-medium'>Question</th>
                    <th scope='col' className='px-4 py-2.5 font-medium'>Sources</th>
                    <th scope='col' className='px-4 py-2.5 font-medium'>Tokens</th>
                    <th scope='col' className='px-4 py-2.5 font-medium'>Time</th>
                    <th scope='col' className='px-4 py-2.5 font-medium'>When</th>
                  </tr>
                </thead>
                <tbody>
                  {traces.map((trace) => (
                    <tr key={trace.id} className='border-b border-line last:border-0'>
                      <td className='px-4 py-2.5'>
                        <button
                          type='button'
                          onClick={() =>
                            void run(trace.question)}
                          disabled={isRunning}
                          className='rp-clamp-2 max-w-xs text-left text-ink-2 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50'
                          style={{ outlineColor: 'var(--rp-accent)' }}
                        >
                          {trace.question}
                        </button>
                      </td>
                      <td className='px-4 py-2.5 text-ink-2'>{trace.sourceCount}</td>
                      <td className='px-4 py-2.5 text-ink-2'>
                        {trace.tokens ? `${trace.tokens.input} / ${trace.tokens.output}` : 'n/a'}
                      </td>
                      <td className='px-4 py-2.5 text-ink-2'>
                        {trace.seconds !== null ? `${trace.seconds.toFixed(1)}s` : 'n/a'}
                      </td>
                      <td className='px-4 py-2.5 text-ink-3'>{relativeAge(trace.when)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>
    </main>
  )
}
