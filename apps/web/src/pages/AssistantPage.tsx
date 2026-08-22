import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { AskEvent, Citation, ScoredResource } from '@research-portal/core'
import { getSuggestedQuestions, streamAsk } from '../api/client.ts'
import { citationHref, ContextJourney } from '../components/AnswerStream.tsx'
import { type QualityScores, TrustSignals } from '../components/QualityGauge.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// Local types + localStorage persistence
// ---------------------------------------------------------------------------

type ChatMessage = {
  id: string
  author: 'USER' | 'AGENT'
  text: string
  citations: Citation[]
  sources: ScoredResource[]
  usage?: {
    inputTokens: number
    outputTokens: number
    firstChunkSec?: number
    totalSec?: number
  }
  quality?: QualityScores
  error?: string
  pending?: boolean
}

type ChatSession = {
  id: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

const SESSION_CAP = 20

function storageKey(slug: string): string {
  return `rp-chat-${slug}`
}

/**
 * Defensively parses a legacy/malformed `quality` field: older sessions were
 * saved before `quality` existed on `ChatMessage` at all, so anything that
 * isn't a well-shaped `{ number|null, number|null, number|null }` object
 * falls back to `undefined` rather than throwing or leaving bad data around
 * for `TrustSignals` to trip over.
 */
function migrateQuality(raw: unknown): QualityScores | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Partial<QualityScores>
  const isScoreOrNull = (v: unknown): v is number | null => v === null || typeof v === 'number'
  if (
    !isScoreOrNull(value.answerRelevance) || !isScoreOrNull(value.groundedness) ||
    !isScoreOrNull(value.contextRelevance)
  ) {
    return undefined
  }
  return {
    answerRelevance: value.answerRelevance,
    groundedness: value.groundedness,
    contextRelevance: value.contextRelevance,
  }
}

/**
 * Defensively rebuilds a message from localStorage: older sessions were
 * saved before `sources` (and later `quality`) existed on `ChatMessage`, so
 * any missing/malformed field falls back to an empty array/undefined rather
 * than throwing or leaving bad data around for later code to trip over.
 */
function migrateMessage(raw: unknown): ChatMessage {
  const message = raw as Partial<ChatMessage> | null | undefined
  return {
    id: typeof message?.id === 'string' ? message.id : makeId(),
    author: message?.author === 'USER' ? 'USER' : 'AGENT',
    text: typeof message?.text === 'string' ? message.text : '',
    citations: Array.isArray(message?.citations) ? message.citations : [],
    sources: Array.isArray(message?.sources) ? message.sources : [],
    usage: message?.usage,
    quality: migrateQuality(message?.quality),
    error: typeof message?.error === 'string' ? message.error : undefined,
    pending: false,
  }
}

function migrateSession(raw: unknown): ChatSession | null {
  const session = raw as Partial<ChatSession> | null | undefined
  if (!session || typeof session.id !== 'string') return null
  return {
    id: session.id,
    createdAt: typeof session.createdAt === 'number' ? session.createdAt : Date.now(),
    updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
    messages: Array.isArray(session.messages) ? session.messages.map(migrateMessage) : [],
  }
}

function loadSessions(slug: string): ChatSession[] {
  try {
    const raw = localStorage.getItem(storageKey(slug))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(migrateSession)
      .filter((session): session is ChatSession => session !== null)
  } catch {
    return []
  }
}

function saveSessions(slug: string, sessions: ChatSession[]) {
  try {
    localStorage.setItem(storageKey(slug), JSON.stringify(sessions.slice(0, SESSION_CAP)))
  } catch {
    // localStorage unavailable or full - sessions simply won't persist this run.
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

function sessionTitle(session: ChatSession): string {
  const first = session.messages.find((message) => message.author === 'USER')
  if (!first || first.text.trim().length === 0) return 'New conversation'
  return first.text.length > 60 ? `${first.text.slice(0, 60)}…` : first.text
}

// ---------------------------------------------------------------------------
// Minimal markdown-ish renderer - no libraries. Supports paragraphs split on
// blank lines, "### " headings, "- " bullet lists and **bold** spans.
// ---------------------------------------------------------------------------

/**
 * Replaces `[n]` markers in a plain-text run with superscript, accent-
 * coloured links to the matching citation's deep link. Run AFTER other
 * inline parsing (bold) has already split the text into nodes, so this only
 * ever sees plain text segments - never markup.
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
    part.startsWith('**') && part.endsWith('**')
      ? [<strong key={index}>{part.slice(2, -2)}</strong>]
      : renderCitationMarkers(part, citations, sources, slug, String(index))
  )
}

function renderMarkdown(
  text: string,
  citations: Citation[],
  sources: ScoredResource[],
  slug: string,
): ReactNode {
  const blocks = text.split(/\n{2,}/).filter((block) => block.trim().length > 0)
  return (
    <div className='space-y-3'>
      {blocks.map((block, index) => {
        const trimmed = block.trim()
        if (trimmed.startsWith('### ')) {
          return (
            <h3 key={index} className='text-sm font-semibold text-ink'>
              {renderInline(trimmed.slice(4), citations, sources, slug)}
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
                  {renderInline(line.slice(2), citations, sources, slug)}
                </li>
              ))}
            </ul>
          )
        }
        return (
          <p key={index} className='text-sm leading-relaxed text-ink-2'>
            {renderInline(trimmed, citations, sources, slug)}
          </p>
        )
      })}
    </div>
  )
}

const STAGE_LABELS: Record<string, string> = {
  preprocessing: 'Preparing your question…',
  retrieval: 'Retrieving sources…',
  generating: 'Generating…',
  validating: 'Checking the answer…',
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function SessionList({
  sessions,
  activeSessionId,
  onSelect,
  onNew,
}: {
  sessions: ChatSession[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}) {
  return (
    <div className='flex h-full flex-col'>
      <button
        type='button'
        onClick={onNew}
        className='rp-btn rp-btn-primary w-full'
      >
        + New session
      </button>

      <nav aria-label='Chat sessions' className='mt-4 flex-1 space-y-1.5 overflow-y-auto'>
        {sessions.length === 0
          ? <p className='px-1 py-2 text-xs text-ink-3'>No sessions yet.</p>
          : sessions.map((session) => {
            const isActive = session.id === activeSessionId
            return (
              <button
                key={session.id}
                type='button'
                onClick={() => onSelect(session.id)}
                aria-current={isActive ? 'true' : undefined}
                className={`w-full rounded-[var(--rp-radius)] px-3 py-2.5 text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                  isActive ? 'bg-surface shadow-sm' : 'hover:bg-[var(--rp-surface-2)]'
                }`}
                style={{ outlineColor: 'var(--rp-accent)' }}
              >
                <p className='rp-clamp-2 text-sm font-medium text-ink'>
                  {sessionTitle(session)}
                </p>
                <p className='mt-0.5 text-xs text-ink-3'>
                  {session.messages.length} {session.messages.length === 1 ? 'message' : 'messages'}
                  {' · '}
                  {relativeAge(session.updatedAt)}
                </p>
              </button>
            )
          })}
      </nav>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Message bubbles
// ---------------------------------------------------------------------------

function UserBubble({ message }: { message: ChatMessage }) {
  return (
    <div className='flex justify-end'>
      <div
        className='max-w-[85%] rounded-[calc(var(--rp-radius)+4px)] rounded-tr-sm px-4 py-3 text-sm leading-relaxed text-ink sm:max-w-[70%]'
        style={{ backgroundColor: 'color-mix(in srgb, var(--rp-accent) 14%, var(--rp-surface))' }}
      >
        {message.text}
      </div>
    </div>
  )
}

function AssistantCard({
  message,
  slug,
  question,
  activeStage,
  onRetry,
}: {
  message: ChatMessage
  slug: string
  question: string
  activeStage: string | null
  onRetry: () => void
}) {
  if (message.error) {
    return (
      <div
        className='rounded-[calc(var(--rp-radius)+4px)] border p-5'
        style={{ borderColor: 'var(--rp-bad-line)', background: 'var(--rp-bad-bg)' }}
      >
        <p className='text-sm font-medium text-[var(--rp-bad-ink)]'>Something went wrong</p>
        <p className='mt-1 text-sm text-[var(--rp-bad-ink)]'>{message.error}</p>
        <button type='button' onClick={onRetry} className='rp-btn rp-btn-danger mt-3'>
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-5 shadow-sm'>
      {message.pending && activeStage
        ? (
          <p className='mb-2 flex items-center gap-2 text-xs font-medium text-ink-3'>
            <span
              className='h-1.5 w-1.5 animate-pulse rounded-full'
              style={{ backgroundColor: 'var(--rp-accent)' }}
              aria-hidden='true'
            />
            {activeStage}
          </p>
        )
        : null}

      {message.text.length > 0
        ? renderMarkdown(message.text, message.citations, message.sources, slug)
        : message.pending
        ? <p className='text-sm text-ink-3'>Thinking…</p>
        : null}

      {message.pending && message.text.length > 0
        ? (
          <span
            className='ml-0.5 inline-block h-4 w-1.5 animate-pulse align-text-bottom'
            style={{ backgroundColor: 'var(--rp-accent)' }}
            aria-hidden='true'
          />
        )
        : null}

      {message.citations.length > 0
        ? (
          <div className='mt-4 border-t border-line pt-3'>
            <p className='text-xs font-medium text-ink-3'>
              Sources: {message.citations.length}
            </p>
            <div className='mt-2 flex flex-wrap gap-1.5'>
              {message.citations.map((citation) => {
                const matchedPassage = message.sources.find((source) =>
                  source.id === citation.resourceId
                )?.matchedPassage
                return (
                  <Link
                    key={citation.index}
                    to={citationHref(slug, citation.resourceId, matchedPassage)}
                    title={citation.title}
                    className='rp-chip'
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

      {message.quality
        ? (
          <div className='mt-3'>
            <TrustSignals quality={message.quality} />
          </div>
        )
        : null}

      {message.usage
        ? (
          <p className='mt-3 text-xs text-ink-3'>
            {message.usage.inputTokens} in / {message.usage.outputTokens} out tokens
          </p>
        )
        : null}

      {!message.pending && message.sources.length > 0
        ? (
          <div className='mt-4 border-t border-line pt-3'>
            <ContextJourney slug={slug} sources={message.sources} query={question} />
          </div>
        )
        : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AssistantPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const [searchParams, setSearchParams] = useSearchParams()

  const [sessions, setSessions] = useState<ChatSession[]>(() => loadSessions(config.slug))
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [activeStageLabel, setActiveStageLabel] = useState<string | null>(null)
  const [showSidebar, setShowSidebar] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const threadEndRef = useRef<HTMLDivElement | null>(null)
  // Guards the `?ask=` handoff from Explore against a double-send (React 18
  // Strict Mode replays effects) and resets whenever the tenant changes.
  const askHandledRef = useRef(false)

  const { data: suggestions } = useQuery({
    queryKey: ['suggested-questions', config.slug],
    queryFn: () => getSuggestedQuestions(config.slug),
  })

  // Re-load sessions if the tenant slug changes.
  useEffect(() => {
    setSessions(loadSessions(config.slug))
    setActiveSessionId(null)
    setMessages([])
    askHandledRef.current = false
  }, [config.slug])

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  // Explore's hero hands a question off here via `?ask=`. Consume it once:
  // strip the param from the URL and auto-send it as a new message, but
  // never while a stream is already running - the effect simply retries on
  // the next isStreaming change since the ref isn't set until it succeeds.
  useEffect(() => {
    const ask = searchParams.get('ask')
    if (!ask || ask.trim().length === 0 || askHandledRef.current || isStreaming) return
    askHandledRef.current = true
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('ask')
        return next
      },
      { replace: true },
    )
    send(ask)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, isStreaming])

  function persist(nextMessages: ChatMessage[], sessionId: string) {
    setSessions((prev) => {
      const existing = prev.find((session) => session.id === sessionId)
      const now = Date.now()
      const updatedSession: ChatSession = existing
        ? { ...existing, messages: nextMessages, updatedAt: now }
        : { id: sessionId, createdAt: now, updatedAt: now, messages: nextMessages }
      const rest = prev.filter((session) => session.id !== sessionId)
      const next = [updatedSession, ...rest].slice(0, SESSION_CAP)
      saveSessions(config.slug, next)
      return next
    })
  }

  function startNewSession() {
    setActiveSessionId(null)
    setMessages([])
    setShowSidebar(false)
  }

  function selectSession(id: string) {
    const session = sessions.find((item) => item.id === id)
    if (!session) return
    setActiveSessionId(id)
    setMessages(session.messages.map((message) => ({ ...message, pending: false })))
    setShowSidebar(false)
  }

  async function runAsk(query: string, baseMessages: ChatMessage[], sessionId: string) {
    const assistantId = makeId()
    // baseMessages ends with the question being asked (as a USER message) - the
    // request sends that as `query`, so prior turns exclude it here.
    const contextTurns = baseMessages
      .slice(0, -1)
      .filter((message) => !message.error)
      .map((message) => ({ author: message.author, text: message.text }))

    let working: ChatMessage[] = [
      ...baseMessages,
      { id: assistantId, author: 'AGENT', text: '', citations: [], sources: [], pending: true },
    ]
    setMessages(working)
    setIsStreaming(true)
    setActiveStageLabel(null)

    const controller = new AbortController()
    abortRef.current = controller

    function update(mutate: (message: ChatMessage) => ChatMessage) {
      working = working.map((message) => message.id === assistantId ? mutate(message) : message)
      setMessages(working)
    }

    try {
      await streamAsk(
        config.slug,
        { query, context: contextTurns },
        (event: AskEvent) => {
          switch (event.type) {
            case 'stage':
              setActiveStageLabel(
                event.status === 'started' ? STAGE_LABELS[event.stage] ?? null : null,
              )
              break
            case 'sources':
              update((message) => ({ ...message, sources: event.resources }))
              break
            case 'delta':
              update((message) => ({ ...message, text: message.text + event.text }))
              break
            case 'citation':
              update((message) =>
                message.citations.some((citation) => citation.index === event.citation.index)
                  ? message
                  : { ...message, citations: [...message.citations, event.citation] }
              )
              break
            case 'usage':
              update((message) => ({
                ...message,
                usage: {
                  inputTokens: event.inputTokens,
                  outputTokens: event.outputTokens,
                  firstChunkSec: event.firstChunkSec,
                  totalSec: event.totalSec,
                },
              }))
              break
            case 'quality':
              update((message) => ({
                ...message,
                quality: {
                  answerRelevance: event.answerRelevance,
                  groundedness: event.groundedness,
                  contextRelevance: event.contextRelevance,
                },
              }))
              break
            case 'done':
              update((message) => ({ ...message, pending: false }))
              break
            case 'error':
              update((message) => ({
                ...message,
                pending: false,
                error: event.message,
              }))
              break
          }
        },
        controller.signal,
      )
    } catch (thrown) {
      if (controller.signal.aborted) {
        update((existing) =>
          existing.text.length > 0
            ? { ...existing, pending: false }
            : { ...existing, pending: false, error: 'Stopped before an answer arrived.' }
        )
      } else {
        const message = thrown instanceof Error
          ? thrown.message
          : 'The assistant could not complete this answer.'
        update((existing) => ({ ...existing, pending: false, error: message }))
      }
    } finally {
      setIsStreaming(false)
      setActiveStageLabel(null)
      abortRef.current = null
      persist(working, sessionId)
    }
  }

  function send(query: string) {
    const trimmed = query.trim()
    if (trimmed.length === 0 || isStreaming) return

    const sessionId = activeSessionId ?? makeId()
    if (!activeSessionId) setActiveSessionId(sessionId)

    const userMessage: ChatMessage = {
      id: makeId(),
      author: 'USER',
      text: trimmed,
      citations: [],
      sources: [],
    }
    const baseMessages = [...messages, userMessage]
    setMessages(baseMessages)
    setDraft('')
    void runAsk(trimmed, baseMessages, sessionId)
  }

  function retry(forMessageId: string) {
    // Find the user message immediately preceding the failed assistant message.
    const index = messages.findIndex((message) => message.id === forMessageId)
    if (index <= 0) return
    const userMessage = messages[index - 1]
    if (!userMessage || userMessage.author !== 'USER') return
    const baseMessages = messages.slice(0, index)
    const sessionId = activeSessionId ?? makeId()
    if (!activeSessionId) setActiveSessionId(sessionId)
    setMessages(baseMessages)
    void runAsk(userMessage.text, baseMessages, sessionId)
  }

  function stop() {
    abortRef.current?.abort()
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    send(draft)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send(draft)
    }
  }

  const isEmpty = messages.length === 0

  return (
    <main
      aria-label='Research assistant'
      className='mx-auto flex h-[calc(100vh-65px)] max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6 sm:py-6 lg:flex-row lg:gap-6'
    >
      <div className='flex shrink-0 items-center justify-between lg:hidden'>
        <button
          type='button'
          onClick={() => setShowSidebar(true)}
          className='rp-chip h-9 sm:h-7'
        >
          Sessions
        </button>
      </div>

      <aside
        aria-label='Chat sessions'
        className='hidden w-64 shrink-0 rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-3 lg:flex'
      >
        <SessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={selectSession}
          onNew={startNewSession}
        />
      </aside>

      {showSidebar
        ? (
          <div className='fixed inset-0 z-40 flex lg:hidden'>
            <button
              type='button'
              aria-label='Close sessions'
              onClick={() => setShowSidebar(false)}
              className='flex-1 bg-black/30'
            />
            <div className='h-full w-72 max-w-[80vw] bg-surface-2 p-3 shadow-xl'>
              <SessionList
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelect={selectSession}
                onNew={startNewSession}
              />
            </div>
          </div>
        )
        : null}

      <div className='flex min-w-0 flex-1 flex-col'>
        <section
          aria-label='Conversation'
          className='flex-1 space-y-4 overflow-y-auto pb-4'
        >
          {isEmpty
            ? (
              <div className='space-y-4'>
                <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-6 shadow-sm'>
                  <h1 className='text-lg font-semibold tracking-tight text-ink'>
                    Ask {config.branding.productName}
                  </h1>
                  <p className='mt-1 text-sm text-ink-3'>
                    Ask a question in plain language and get a grounded, cited answer drawn from the
                    corpus.
                  </p>
                </div>
                {suggestions && suggestions.length > 0
                  ? (
                    <div className='flex flex-wrap gap-2'>
                      {suggestions.slice(0, 6).map((question) => (
                        <button
                          key={question.id}
                          type='button'
                          onClick={() => send(question.text)}
                          className='rp-chip h-9 sm:h-7'
                        >
                          {question.text}
                        </button>
                      ))}
                    </div>
                  )
                  : null}
              </div>
            )
            : (
              messages.map((message, index) =>
                message.author === 'USER'
                  ? <UserBubble key={message.id} message={message} />
                  : (
                    <AssistantCard
                      key={message.id}
                      message={message}
                      slug={config.slug}
                      question={messages[index - 1]?.author === 'USER'
                        ? messages[index - 1]?.text ?? ''
                        : ''}
                      activeStage={index === messages.length - 1 ? activeStageLabel : null}
                      onRetry={() => retry(message.id)}
                    />
                  )
              )
            )}
          <div ref={threadEndRef} />
        </section>

        <form onSubmit={handleSubmit} className='mt-2 shrink-0'>
          <div className='flex items-end gap-2 rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-2 shadow-sm'>
            <label htmlFor='assistant-composer' className='sr-only'>
              Ask a question
            </label>
            <textarea
              id='assistant-composer'
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
              rows={1}
              placeholder={config.searchPlaceholder}
              className='max-h-40 min-w-0 flex-1 resize-none rounded-[var(--rp-radius)] border-0 bg-transparent px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-60'
            />
            {isStreaming
              ? (
                <button
                  type='button'
                  onClick={stop}
                  className='rp-btn rp-btn-outline shrink-0'
                >
                  Stop
                </button>
              )
              : (
                <button
                  type='submit'
                  disabled={draft.trim().length === 0}
                  className='rp-btn rp-btn-primary shrink-0'
                >
                  Send
                </button>
              )}
          </div>
          <p className='mt-1.5 px-1 text-xs text-ink-3'>
            Enter to send &middot; Shift+Enter for a new line
          </p>
        </form>
      </div>
    </main>
  )
}
