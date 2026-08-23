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
import {
  addWatch,
  deleteServerSession,
  getServerSession,
  getSubqueries,
  getSuggestedQuestions,
  listServerSessions,
  putServerSession,
  sendAnswerFeedback,
  streamAsk,
} from '../api/client.ts'
import { citationHref, ContextJourney } from '../components/AnswerStream.tsx'
import {
  type EvidenceSource,
  EvidenceTable,
  type EvidenceVerdictInfo,
} from '../components/EvidenceTable.tsx'
import { PipelinePanel } from '../components/PipelinePanel.tsx'
import { type QualityScores, TrustSignals } from '../components/QualityGauge.tsx'
import { LiveStatus } from '../components/ui.tsx'
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
  /** How the platform interpreted/rephrased the question (first turn only). */
  interpretedQuery?: string
  /** Platform learning id for this answer - target for feedback. */
  learningId?: string
  feedbackGood?: boolean
  feedbackSubmitted?: boolean
  /** Sub-questions the platform researched alongside this (deep research mode). */
  subqueries?: string[]
  /** Set once the self-heal "re-answer deeply" suggestion has been actioned. */
  healDismissed?: boolean
  /** Marks an answer produced by re-asking a thinly-grounded answer deeply. */
  deepBadge?: boolean
  /** True when this answer already used full-document (deep) grounding. */
  wasDeep?: boolean
  /** True when the corpus could not answer and guidance was shown instead of a real answer. */
  refused?: boolean
  /** Per-source AI relevance verdicts, once judged - persisted so the Evidence table doesn't re-judge on reload. */
  verdicts?: Record<string, EvidenceVerdictInfo>
}

type ChatSession = {
  id: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  /** User-set name, overriding the auto-title derived from the first question. */
  title?: string
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
    interpretedQuery: typeof message?.interpretedQuery === 'string'
      ? message.interpretedQuery
      : undefined,
    learningId: typeof message?.learningId === 'string' ? message.learningId : undefined,
    feedbackGood: typeof message?.feedbackGood === 'boolean' ? message.feedbackGood : undefined,
    feedbackSubmitted: typeof message?.feedbackSubmitted === 'boolean'
      ? message.feedbackSubmitted
      : undefined,
    subqueries: Array.isArray(message?.subqueries)
      ? message.subqueries.filter((item): item is string => typeof item === 'string')
      : undefined,
    healDismissed: typeof message?.healDismissed === 'boolean' ? message.healDismissed : undefined,
    deepBadge: typeof message?.deepBadge === 'boolean' ? message.deepBadge : undefined,
    wasDeep: typeof message?.wasDeep === 'boolean' ? message.wasDeep : undefined,
    refused: typeof message?.refused === 'boolean' ? message.refused : undefined,
    verdicts: message?.verdicts && typeof message.verdicts === 'object'
      ? message.verdicts as Record<string, EvidenceVerdictInfo>
      : undefined,
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
    title: typeof session.title === 'string' && session.title.trim().length > 0
      ? session.title
      : undefined,
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

function saveSessions(slug: string, sessions: ChatSession[], deletedIds?: Set<string>) {
  try {
    // Merge with what is currently stored: another tab may have added or
    // updated sessions since this tab mounted. In-memory wins for ids we
    // hold; stored-only ids are kept unless this tab deleted them.
    const stored = loadSessions(slug)
    const mine = new Map(sessions.map((s) => [s.id, s]))
    const merged = [
      ...sessions,
      ...stored.filter((s) => !mine.has(s.id) && !(deletedIds?.has(s.id))),
    ]
    merged.sort((a, b) => b.updatedAt - a.updatedAt)
    localStorage.setItem(storageKey(slug), JSON.stringify(merged.slice(0, SESSION_CAP)))
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
  if (session.title && session.title.trim().length > 0) return session.title
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
            title={`Source ${citationIndex} - ${citation.title}; click to open, or find it in the Evidence table below`}
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
  onDelete,
  onRename,
}: {
  sessions: ChatSession[]
  activeSessionId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')

  function startEdit(session: ChatSession) {
    setEditingId(session.id)
    setDraftTitle(sessionTitle(session))
  }

  function commitEdit() {
    const trimmed = draftTitle.trim()
    if (editingId && trimmed.length > 0) onRename(editingId, trimmed)
    setEditingId(null)
  }

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
            const isEditing = editingId === session.id
            if (isEditing) {
              return (
                <form
                  key={session.id}
                  onSubmit={(event) => {
                    event.preventDefault()
                    commitEdit()
                  }}
                  className='px-1 py-1'
                >
                  <input
                    type='text'
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') setEditingId(null)
                    }}
                    aria-label='Session name'
                    autoFocus
                    className='rp-input h-9 text-sm'
                  />
                </form>
              )
            }
            return (
              <div key={session.id} className='group relative'>
                <button
                  type='button'
                  onClick={() => onSelect(session.id)}
                  aria-current={isActive ? 'true' : undefined}
                  className={`w-full rounded-[var(--rp-radius)] px-3 py-2.5 ${
                    isActive ? 'pr-14' : 'pr-8'
                  } text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
                    isActive ? 'bg-surface shadow-sm' : 'hover:bg-[var(--rp-surface-2)]'
                  }`}
                  style={{ outlineColor: 'var(--rp-accent)' }}
                >
                  <p className='rp-clamp-2 text-sm font-medium text-ink'>
                    {sessionTitle(session)}
                  </p>
                  <p className='mt-0.5 text-xs text-ink-3'>
                    {session.messages.length}{' '}
                    {session.messages.length === 1 ? 'message' : 'messages'}
                    {' · '}
                    {relativeAge(session.updatedAt)}
                  </p>
                </button>
                {isActive
                  ? (
                    <button
                      type='button'
                      onClick={(event) => {
                        event.stopPropagation()
                        startEdit(session)
                      }}
                      aria-label={`Rename "${sessionTitle(session)}"`}
                      title='Rename session'
                      className='rp-focus absolute right-8 top-1.5 flex h-6 w-6 items-center justify-center rounded-[6px] text-ink-3 opacity-0 transition-opacity duration-150 hover:bg-[var(--rp-surface-2)] hover:text-ink group-hover:opacity-100 focus-visible:opacity-100'
                    >
                      ✎
                    </button>
                  )
                  : null}
                <button
                  type='button'
                  onClick={(event) => {
                    event.stopPropagation()
                    onDelete(session.id)
                  }}
                  aria-label={`Delete "${sessionTitle(session)}"`}
                  title='Delete session'
                  className='rp-focus absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-[6px] text-ink-3 opacity-0 transition-opacity duration-150 hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-bad-ink)] group-hover:opacity-100 focus-visible:opacity-100'
                >
                  &times;
                </button>
              </div>
            )
          })}
      </nav>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Message bubbles
// ---------------------------------------------------------------------------

function UserBubble({
  message,
  onAskSubquery,
}: {
  message: ChatMessage
  onAskSubquery: (subquery: string) => void
}) {
  return (
    <div className='flex flex-col items-end gap-1.5'>
      <div
        className='max-w-[85%] rounded-[calc(var(--rp-radius)+4px)] rounded-tr-sm px-4 py-3 text-sm leading-relaxed text-ink sm:max-w-[70%]'
        style={{ backgroundColor: 'color-mix(in srgb, var(--rp-accent) 14%, var(--rp-surface))' }}
      >
        {message.text}
      </div>
      {message.subqueries && message.subqueries.length > 0
        ? (
          <div className='flex max-w-[85%] flex-col items-end gap-1 sm:max-w-[70%]'>
            <p className='text-[11px] font-medium uppercase tracking-wide text-ink-3'>
              Searched for
            </p>
            <div className='flex flex-wrap justify-end gap-1.5'>
              {message.subqueries.map((subquery, index) => (
                <button
                  key={index}
                  type='button'
                  onClick={() => onAskSubquery(subquery)}
                  className='rp-chip text-[11px]'
                >
                  {subquery}
                </button>
              ))}
            </div>
          </div>
        )
        : null}
    </div>
  )
}

/**
 * Small ghost thumbs-up/thumbs-down pair for the platform's learning loop.
 * Hidden entirely when the message has no `learningId` (nothing to attach
 * feedback to). Once either button is used the row collapses to a quiet
 * "thanks" line; a negative rating additionally offers a one-line detail
 * field that re-posts the same feedback with free text attached.
 */
function FeedbackControl({
  message,
  onFeedback,
}: {
  message: ChatMessage
  onFeedback: (good: boolean, text?: string) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState('')
  const [detailSent, setDetailSent] = useState(false)

  if (!message.learningId) return null

  async function handleRate(good: boolean) {
    setError(null)
    setBusy(true)
    const ok = await onFeedback(good)
    setBusy(false)
    if (!ok) setError('Could not send feedback - try again.')
  }

  async function handleDetailSend() {
    if (detail.trim().length === 0) return
    setError(null)
    setBusy(true)
    const ok = await onFeedback(false, detail.trim())
    setBusy(false)
    if (ok) setDetailSent(true)
    else setError('Could not send feedback - try again.')
  }

  if (message.feedbackSubmitted) {
    return (
      <div className='flex flex-col items-start gap-1.5'>
        <p className='text-xs text-ink-3'>Thanks - feedback sent to the platform.</p>
        {message.feedbackGood === false && !detailSent
          ? (
            <div className='flex items-center gap-1.5'>
              <input
                type='text'
                value={detail}
                onChange={(event) => setDetail(event.target.value)}
                placeholder='What was wrong? (optional)'
                disabled={busy}
                className='rp-input h-7 w-48 text-xs'
              />
              <button
                type='button'
                onClick={handleDetailSend}
                disabled={busy || detail.trim().length === 0}
                className='rp-btn rp-btn-ghost h-7 px-2 text-xs'
              >
                Send
              </button>
            </div>
          )
          : null}
        {error ? <p className='text-xs text-[var(--rp-bad-ink)]'>{error}</p> : null}
      </div>
    )
  }

  return (
    <div className='flex items-center gap-1'>
      <button
        type='button'
        onClick={() => handleRate(true)}
        disabled={busy}
        aria-label='Helpful answer'
        title='Helpful answer'
        className='rp-btn rp-btn-ghost h-7 px-2 text-xs'
      >
        Helpful
      </button>
      <button
        type='button'
        onClick={() => handleRate(false)}
        disabled={busy}
        aria-label='Not a helpful answer'
        title='Not a helpful answer'
        className='rp-btn rp-btn-ghost h-7 px-2 text-xs'
      >
        Not helpful
      </button>
      {error ? <p className='text-xs text-[var(--rp-bad-ink)]'>{error}</p> : null}
    </div>
  )
}

/**
 * Saves the question behind an answer as a watch so the tenant sees a
 * "changed" badge in Search when new results turn up for it later. Purely
 * local UI state - a page reload simply lets the user watch it again.
 */
function WatchControl({ question, slug }: { question: string; slug: string }) {
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')

  if (question.trim().length === 0) return null

  async function handleWatch() {
    setStatus('busy')
    try {
      await addWatch(slug, question)
      setStatus('done')
    } catch {
      setStatus('error')
    }
  }

  if (status === 'done') {
    return (
      <p className='text-xs text-ink-3'>
        Watching - you will see a change badge in Search when results change.
      </p>
    )
  }

  return (
    <div className='flex items-center gap-1.5'>
      <button
        type='button'
        onClick={handleWatch}
        disabled={status === 'busy'}
        className='rp-btn rp-btn-ghost h-7 px-2 text-xs'
      >
        {status === 'busy' ? 'Watching…' : 'Watch this question'}
      </button>
      {status === 'error'
        ? <p className='text-xs text-[var(--rp-bad-ink)]'>Could not save the watch - try again.</p>
        : null}
    </div>
  )
}

function AssistantCard({
  message,
  slug,
  question,
  subqueries,
  activeStage,
  onRetry,
  onFeedback,
  onReanswerDeeply,
  onAskSubquery,
  onVerdicts,
}: {
  message: ChatMessage
  slug: string
  question: string
  subqueries: string[]
  activeStage: string | null
  onRetry: () => void
  onFeedback: (good: boolean, text?: string) => Promise<boolean>
  onReanswerDeeply: () => void
  onAskSubquery: (subquery: string) => void
  onVerdicts: (verdicts: Record<string, EvidenceVerdictInfo>) => void
}) {
  const [showPipeline, setShowPipeline] = useState(false)

  if (message.error && !message.text.trim()) {
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

  // Only offer the deep re-answer when the original ask was not already deep,
  // and only for genuinely weak answers - REMi grades some corpora harshly, so
  // a well-cited answer at 2/5 should not carry an amber warning.
  const groundedness = message.quality?.groundedness
  const citationCount = message.citations?.length ?? 0
  const isThinlyGrounded = !message.pending && !message.healDismissed && !message.wasDeep &&
    !message.deepBadge && groundedness !== null && groundedness !== undefined &&
    (groundedness <= 1 || (groundedness <= 2 && citationCount <= 1))
  const isSparselyGrounded = !message.pending && groundedness !== null &&
    groundedness !== undefined &&
    groundedness <= 2

  const evidenceSources: EvidenceSource[] = message.sources.map((source) => ({
    id: source.id,
    title: source.title,
    passage: source.matchedPassage,
    score: source.relevance,
    matchedPage: source.matchedPage,
    referenceChunk: source.referenceChunk,
  }))

  // A refusal gets its own structured "no evidence" state instead of the
  // normal answer body - the guidance sentence the platform generated, what
  // WAS retrieved (unjudged, so the user sees raw scores rather than another
  // AI opinion), and next actions rather than a dead end.
  if (!message.pending && message.refused) {
    return (
      <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-5 shadow-sm'>
        {message.interpretedQuery
          ? (
            <p className='mb-2 text-xs text-ink-3'>
              Interpreted as &ldquo;{message.interpretedQuery}&rdquo;
            </p>
          )
          : null}

        <div className='mb-2'>
          <span className='rp-badge rp-badge-quiet'>No direct evidence found</span>
        </div>

        {message.text.length > 0
          ? renderMarkdown(message.text, message.citations, message.sources, slug)
          : null}

        {evidenceSources.length > 0
          ? (
            <div className='mt-4 border-t border-line pt-3'>
              <EvidenceTable
                slug={slug}
                question={question}
                sources={evidenceSources}
                judge={false}
                title='Closest passages found'
              />
            </div>
          )
          : null}

        <div className='mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3'>
          <WatchControl question={question} slug={slug} />
        </div>

        {subqueries.length > 0
          ? (
            <div className='mt-3 flex flex-wrap gap-1.5'>
              {subqueries.map((subquery, index) => (
                <button
                  key={index}
                  type='button'
                  onClick={() => onAskSubquery(subquery)}
                  className='rp-chip text-[11px]'
                >
                  {subquery}
                </button>
              ))}
            </div>
          )
          : null}
      </div>
    )
  }

  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface p-5 shadow-sm'>
      {message.deepBadge || message.interpretedQuery
        ? (
          <div className='mb-2 flex flex-wrap items-center gap-2'>
            {message.deepBadge
              ? <span className='rp-badge rp-badge-quiet'>Deep re-answer</span>
              : null}
            {message.interpretedQuery
              ? (
                <p className='text-xs text-ink-3'>
                  Interpreted as &ldquo;{message.interpretedQuery}&rdquo;
                </p>
              )
              : null}
          </div>
        )
        : null}

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

      {message.error && message.text.trim()
        ? (
          <div
            className='mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--rp-radius)] border p-3'
            style={{ borderColor: 'var(--rp-bad-line)', background: 'var(--rp-bad-bg)' }}
          >
            <p className='text-xs text-[var(--rp-bad-ink)]'>
              The answer was cut short - {message.error}
            </p>
            <button
              type='button'
              onClick={onRetry}
              className='rp-btn rp-btn-outline h-7 shrink-0 px-2 text-xs'
            >
              Retry
            </button>
          </div>
        )
        : null}

      {isThinlyGrounded
        ? (
          <div
            className='mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[var(--rp-radius)] border p-3'
            style={{ borderColor: 'var(--rp-warn-line)', background: 'var(--rp-warn-bg)' }}
          >
            <p className='text-xs text-[var(--rp-warn-ink)]'>
              This answer is thinly grounded - re-answer with full-document context?
            </p>
            <button
              type='button'
              onClick={onReanswerDeeply}
              className='rp-btn rp-btn-outline h-7 shrink-0 px-2 text-xs'
            >
              Re-answer deeply
            </button>
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

      {isSparselyGrounded && evidenceSources.length > 0
        ? (
          <p className='mt-3 text-xs text-[var(--rp-warn-ink)]'>
            Parts of this answer go beyond the retrieved passages - check the evidence below before
            relying on it.
          </p>
        )
        : null}

      {!message.pending && evidenceSources.length > 0
        ? (
          <div className='mt-3'>
            <EvidenceTable
              slug={slug}
              question={question}
              sources={evidenceSources}
              initialVerdicts={message.verdicts}
              onVerdicts={onVerdicts}
              citations={message.citations}
              anchorPrefix={message.id}
            />
          </div>
        )
        : null}

      {!message.pending && (message.quality || message.learningId || question.trim().length > 0)
        ? (
          <div className='mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3'>
            {message.quality ? <TrustSignals quality={message.quality} /> : <span />}
            <div className='flex flex-wrap items-center gap-3'>
              <FeedbackControl message={message} onFeedback={onFeedback} />
              <WatchControl question={question} slug={slug} />
            </div>
          </div>
        )
        : null}

      {!message.pending && message.sources.length > 0
        ? (
          <div className='mt-4 border-t border-line pt-3'>
            <ContextJourney slug={slug} sources={message.sources} query={question} />
          </div>
        )
        : null}

      {!message.pending && (message.sources.length > 0 || message.usage || message.quality)
        ? (
          <div className='mt-4 border-t border-line pt-3'>
            <button
              type='button'
              onClick={() => setShowPipeline((prev) => !prev)}
              aria-expanded={showPipeline}
              className='flex items-center gap-1.5 text-xs font-medium text-ink-3 hover:text-ink'
            >
              <svg
                viewBox='0 0 20 20'
                fill='none'
                stroke='currentColor'
                strokeWidth='1.7'
                strokeLinecap='round'
                strokeLinejoin='round'
                aria-hidden='true'
                className={`h-3 w-3 shrink-0 transition-transform duration-150 ${
                  showPipeline ? 'rotate-90' : ''
                }`}
              >
                <path d='M7 4l6 6-6 6' />
              </svg>
              {showPipeline ? 'Hide the pipeline' : 'Show the pipeline'}
            </button>
            {showPipeline
              ? (
                <div className='mt-3'>
                  <PipelinePanel
                    sources={message.sources}
                    usage={message.usage}
                    quality={message.quality}
                  />
                </div>
              )
              : null}
          </div>
        )
        : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Export - a standalone Word-compatible .doc of the current research trail.
// Mirrors the export idiom in GeneratePage.tsx (a self-contained HTML shell
// with the Word-namespaced <head>), rebuilt locally here since GeneratePage
// doesn't export its helpers.
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function slugOrDate(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
  return slug.length > 0 ? slug.slice(0, 60) : new Date().toISOString().slice(0, 10)
}

function formatScore(score: number | null | undefined): string {
  return score === null || score === undefined ? 'n/a' : `${score}/5`
}

/**
 * Renders the research trail as clean semantic HTML: one heading per
 * question, the answer text below it, a bracketed citation list of source
 * titles, and the REMi quality line when the platform scored the answer.
 */
function sessionToWordHtml(portalName: string, title: string, messages: ChatMessage[]): string {
  const dateLine = new Date().toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  const turnsHtml = messages
    .map((message) => {
      if (message.author === 'USER') {
        return `<h2>${escapeHtml(message.text)}</h2>`
      }
      if (message.error) {
        return `<p><em>Answer unavailable - ${escapeHtml(message.error)}</em></p>`
      }
      const answerHtml = message.text
        .split(/\n{2,}/)
        .filter((block) => block.trim().length > 0)
        .map((block) => `<p>${escapeHtml(block.trim())}</p>`)
        .join('')
      const citationsHtml = message.citations.length > 0
        ? `<p>[${message.citations.map((citation) => escapeHtml(citation.title)).join('; ')}]</p>`
        : ''
      const qualityHtml = message.quality
        ? `<p><em>Answer relevance ${
          formatScore(message.quality.answerRelevance)
        } &middot; Groundedness ${
          formatScore(message.quality.groundedness)
        } &middot; Context relevance ${formatScore(message.quality.contextRelevance)}</em></p>`
        : ''
      return `${answerHtml}${citationsHtml}${qualityHtml}`
    })
    .join('')

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]>
<xml>
<w:WordDocument>
<w:View>Print</w:View>
<w:Zoom>100</w:Zoom>
<w:DoNotOptimizeForBrowser/>
</w:WordDocument>
</xml>
<![endif]-->
<style>
body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; line-height: 1.5; }
h1, h2 { font-family: Arial, Helvetica, sans-serif; color: #111111; }
h1 { font-size: 20pt; margin-bottom: 4pt; }
h2 { font-size: 13pt; margin-top: 18pt; margin-bottom: 6pt; }
p { margin: 6pt 0; font-size: 11pt; }
</style>
</head>
<body>
<h1>${escapeHtml(portalName)}</h1>
<p>${escapeHtml(title)} &middot; ${escapeHtml(dateLine)}</p>
${turnsHtml}
</body>
</html>`
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
  const [deepResearch, setDeepResearch] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  /** Sessions deleted in THIS tab - saveSessions must not resurrect them. */
  const deletedIdsRef = useRef(new Set<string>())

  // Leaving the page cancels any in-flight answer stream.
  useEffect(() => () => abortRef.current?.abort(), [])
  const threadEndRef = useRef<HTMLDivElement | null>(null)
  const sidebarDrawerRef = useRef<HTMLDivElement | null>(null)
  // Guards the `?ask=` handoff from Explore against a double-send (React 18
  // Strict Mode replays effects) and resets whenever the tenant changes.
  const askHandledRef = useRef(false)
  // Debounced per-session background sync to the server, keyed by session id.
  const syncTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const { data: suggestions } = useQuery({
    queryKey: ['suggested-questions', config.slug],
    queryFn: () => getSuggestedQuestions(config.slug),
  })

  /**
   * Fire-and-forget push of one session to the server, debounced so a burst
   * of edits (streaming deltas, renames) collapses into a single request.
   * Failures are silent - offline / server-sync-unavailable simply means the
   * localStorage copy (already saved by `persist`) stays the source of truth.
   */
  function scheduleServerSync(session: ChatSession) {
    const timers = syncTimersRef.current
    const existing = timers.get(session.id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(session.id)
      void putServerSession(config.slug, {
        id: session.id,
        title: sessionTitle(session),
        updatedAt: new Date(session.updatedAt).toISOString(),
        messages: session.messages,
      }).catch(() => {
        // Offline or server sync unavailable - the local session already
        // persisted, so the research trail still works fully offline.
      })
    }, 1500)
    timers.set(session.id, timer)
  }

  // The mobile sessions drawer is a dialog: Escape closes it, and focus
  // moves into it on open so keyboard users land in the right place.
  useEffect(() => {
    if (!showSidebar) return
    sidebarDrawerRef.current?.focus()
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setShowSidebar(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showSidebar])

  // Re-load sessions if the tenant slug changes, then merge in any
  // server-side sessions this browser doesn't have locally yet (or that are
  // newer on the server) - background, silent-fail so offline use is
  // unaffected.
  useEffect(() => {
    const localSessions = loadSessions(config.slug)
    setSessions(localSessions)
    setActiveSessionId(null)
    setMessages([])
    askHandledRef.current = false

    for (const timer of syncTimersRef.current.values()) clearTimeout(timer)
    syncTimersRef.current.clear()

    let cancelled = false
    async function syncFromServer() {
      try {
        const remoteMetas = await listServerSessions(config.slug)
        if (cancelled) return
        const toFetch = remoteMetas.filter((meta) => {
          const local = localSessions.find((session) => session.id === meta.id)
          return !local || Date.parse(meta.updatedAt) > local.updatedAt
        })
        if (toFetch.length === 0) return
        const fetched = await Promise.all(
          toFetch.map((meta) =>
            getServerSession<ChatMessage>(config.slug, meta.id).catch(() => null)
          ),
        )
        if (cancelled) return
        setSessions((prev) => {
          const byId = new Map(prev.map((session) => [session.id, session]))
          for (const remote of fetched) {
            if (!remote) continue
            const updatedAt = Date.parse(remote.updatedAt) || Date.now()
            const existing = byId.get(remote.id)
            if (existing && existing.updatedAt >= updatedAt) continue
            byId.set(remote.id, {
              id: remote.id,
              createdAt: existing?.createdAt ?? updatedAt,
              updatedAt,
              messages: remote.messages.map(migrateMessage),
              title: remote.title.trim().length > 0 ? remote.title : undefined,
            })
          }
          const merged = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, SESSION_CAP)
          saveSessions(config.slug, merged, deletedIdsRef.current)
          return merged
        })
      } catch {
        // Offline or server sync unavailable - local sessions still work.
      }
    }
    void syncFromServer()

    return () => {
      cancelled = true
    }
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
    void send(ask)
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
      saveSessions(config.slug, next, deletedIdsRef.current)
      scheduleServerSync(updatedSession)
      return next
    })
  }

  function startNewSession() {
    if (isStreaming) return
    setActiveSessionId(null)
    setMessages([])
    setShowSidebar(false)
  }

  function deleteSession(id: string) {
    if (isStreaming) return
    deletedIdsRef.current.add(id)
    setSessions((prev) => {
      const next = prev.filter((session) => session.id !== id)
      saveSessions(config.slug, next, deletedIdsRef.current)
      return next
    })
    const timer = syncTimersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      syncTimersRef.current.delete(id)
    }
    void deleteServerSession(config.slug, id).catch(() => {
      // Offline or server sync unavailable - it's already gone locally.
    })
    if (activeSessionId === id) {
      setActiveSessionId(null)
      setMessages([])
    }
  }

  function selectSession(id: string) {
    if (isStreaming) return
    const session = sessions.find((item) => item.id === id)
    if (!session) return
    setActiveSessionId(id)
    setMessages(session.messages.map((message) => ({ ...message, pending: false })))
    setShowSidebar(false)
  }

  /** Sets a custom session name, overriding the auto-title, and syncs it to the server. */
  function renameSession(id: string, title: string) {
    setSessions((prev) => {
      const next = prev.map((session) => session.id === id ? { ...session, title } : session)
      saveSessions(config.slug, next, deletedIdsRef.current)
      const renamed = next.find((session) => session.id === id)
      if (renamed) scheduleServerSync(renamed)
      return next
    })
  }

  async function runAsk(
    query: string,
    baseMessages: ChatMessage[],
    sessionId: string,
    options?: { depth?: 'default' | 'deep'; prequeries?: string[]; deepBadge?: boolean },
  ) {
    const assistantId = makeId()
    // baseMessages ends with the question being asked (as a USER message) - the
    // request sends that as `query`, so prior turns exclude it here.
    const contextTurns = baseMessages
      .slice(0, -1)
      .filter((message) => !message.error)
      .map((message) => ({ author: message.author, text: message.text }))

    let working: ChatMessage[] = [
      ...baseMessages,
      {
        id: assistantId,
        author: 'AGENT',
        text: '',
        citations: [],
        sources: [],
        pending: true,
        deepBadge: options?.deepBadge,
        wasDeep: options?.depth === 'deep',
      },
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
        { query, context: contextTurns, depth: options?.depth, prequeries: options?.prequeries },
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
            case 'learning':
              update((message) => ({ ...message, learningId: event.id }))
              break
            case 'interpreted':
              update((message) => ({ ...message, interpretedQuery: event.query }))
              break
            case 'searched':
              // The platform auto-decomposed the question into sub-queries it
              // researched alongside the main one - attach them to the
              // preceding USER message (immediately before this assistant
              // placeholder in `working`), the same slot deep research fills
              // in before the ask even starts, so they render the same way.
              working = working.map((message, index) =>
                index === working.length - 2 && message.author === 'USER' &&
                  (!message.subqueries || message.subqueries.length === 0)
                  ? { ...message, subqueries: event.queries }
                  : message
              )
              setMessages(working)
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
              update((message) => ({ ...message, pending: false, refused: event.refused }))
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

  async function send(query: string) {
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
    let baseMessages = [...messages, userMessage]
    setMessages(baseMessages)
    setDraft('')

    if (deepResearch) {
      // Map the research space first: a few seconds of structured generation
      // that returns the sub-questions to research alongside the main one.
      // An empty result or a failed call just falls through to a normal deep
      // ask (depth only, no prequeries) - deep research never blocks on this.
      setIsStreaming(true)
      setActiveStageLabel('Mapping the research space…')
      // Stop must work during this phase too - give it a controller before
      // the sub-question call, and bail out if the user aborted meanwhile.
      const mappingController = new AbortController()
      abortRef.current = mappingController
      let subqueries: string[] = []
      try {
        const result = await getSubqueries(config.slug, trimmed)
        subqueries = Array.isArray(result.questions) ? result.questions : []
      } catch {
        subqueries = []
      }
      if (mappingController.signal.aborted) {
        setIsStreaming(false)
        setActiveStageLabel(null)
        return
      }
      if (subqueries.length > 0) {
        baseMessages = baseMessages.map((message) =>
          message.id === userMessage.id ? { ...message, subqueries } : message
        )
        setMessages(baseMessages)
      }
      void runAsk(trimmed, baseMessages, sessionId, { depth: 'deep', prequeries: subqueries })
    } else {
      void runAsk(trimmed, baseMessages, sessionId)
    }
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

  /**
   * Self-heal: re-asks the same question as a new turn with `depth: 'deep'`
   * grounding, badged so it's clear it's a deliberate deep re-answer. Marks
   * the thinly-grounded original so its suggestion bar doesn't offer again.
   */
  function reanswerDeeply(question: string, forMessageId: string) {
    if (isStreaming) return
    const marked = messages.map((message) =>
      message.id === forMessageId ? { ...message, healDismissed: true } : message
    )
    const userMessage: ChatMessage = {
      id: makeId(),
      author: 'USER',
      text: question,
      citations: [],
      sources: [],
    }
    const baseMessages = [...marked, userMessage]
    const sessionId = activeSessionId ?? makeId()
    if (!activeSessionId) setActiveSessionId(sessionId)
    setMessages(baseMessages)
    void runAsk(question, baseMessages, sessionId, { depth: 'deep', deepBadge: true })
  }

  /**
   * Posts feedback for the platform's learning loop and, on success, marks
   * the message so the UI collapses to a quiet "thanks" state. Returns
   * whether it succeeded so the (per-message) control can show its own
   * unobtrusive error text on failure without crashing anything.
   */
  async function sendFeedback(messageId: string, good: boolean, text?: string): Promise<boolean> {
    const message = messages.find((item) => item.id === messageId)
    const sessionId = activeSessionId
    if (!message?.learningId || !sessionId) return false
    try {
      await sendAnswerFeedback(config.slug, { learningId: message.learningId, good, text })
      setMessages((prev) => {
        const next = prev.map((item) =>
          item.id === messageId ? { ...item, feedbackGood: good, feedbackSubmitted: true } : item
        )
        persist(next, sessionId)
        return next
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Persists per-source AI verdicts onto a message once the Evidence table's
   * one-off judge call resolves, so reopening the session doesn't re-judge.
   */
  function saveVerdicts(messageId: string, verdicts: Record<string, EvidenceVerdictInfo>) {
    const sessionId = activeSessionId
    if (!sessionId) return
    setMessages((prev) => {
      const next = prev.map((item) => item.id === messageId ? { ...item, verdicts } : item)
      persist(next, sessionId)
      return next
    })
  }

  function stop() {
    abortRef.current?.abort()
  }

  /** The active session's display title - a custom rename if set, else the auto-title. */
  function currentSessionTitle(): string {
    const active = sessions.find((session) => session.id === activeSessionId)
    return sessionTitle({
      id: '',
      createdAt: 0,
      updatedAt: 0,
      messages,
      title: active?.title,
    })
  }

  /** Downloads the current research trail as a Word-compatible .doc. */
  function exportSession() {
    const title = currentSessionTitle()
    const html = sessionToWordHtml(config.branding.productName, title, messages)
    const blob = new Blob(['﻿', html], { type: 'application/msword' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${slugOrDate(title)}.doc`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void send(draft)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(draft)
    }
  }

  const isEmpty = messages.length === 0
  const lastMessage = messages[messages.length - 1]
  const liveMessage = isStreaming
    ? 'Answer in progress'
    : lastMessage?.author === 'AGENT' && !lastMessage.pending
    ? 'Answer complete'
    : ''

  return (
    <main
      aria-label='Research assistant'
      className='mx-auto flex h-[calc(100dvh-65px)] max-w-6xl flex-col gap-3 px-4 py-4 sm:px-6 sm:py-6 lg:flex-row lg:gap-6'
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
          onDelete={deleteSession}
          onRename={renameSession}
        />
      </aside>

      {showSidebar
        ? (
          <div
            role='dialog'
            aria-modal='true'
            aria-label='Sessions'
            className='fixed inset-0 z-40 flex lg:hidden'
          >
            <button
              type='button'
              aria-label='Close sessions'
              onClick={() => setShowSidebar(false)}
              className='flex-1 bg-black/30'
            />
            <div
              ref={sidebarDrawerRef}
              tabIndex={-1}
              className='h-full w-72 max-w-[80vw] bg-surface-2 p-3 shadow-xl'
            >
              <SessionList
                sessions={sessions}
                activeSessionId={activeSessionId}
                onSelect={selectSession}
                onNew={startNewSession}
                onDelete={deleteSession}
                onRename={renameSession}
              />
            </div>
          </div>
        )
        : null}

      <div className='flex min-w-0 flex-1 flex-col'>
        {!isEmpty
          ? (
            <div className='mb-2 flex shrink-0 items-center justify-between gap-2'>
              <p className='min-w-0 truncate text-sm font-medium text-ink-2'>
                {currentSessionTitle()}
              </p>
              <button
                type='button'
                onClick={exportSession}
                className='rp-btn rp-btn-ghost h-7 shrink-0 px-2 text-xs'
              >
                Export
              </button>
            </div>
          )
          : null}

        <LiveStatus message={liveMessage} />

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
                          onClick={() => void send(question.text)}
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
                  ? (
                    <UserBubble
                      key={message.id}
                      message={message}
                      onAskSubquery={(subquery) => void send(subquery)}
                    />
                  )
                  : (
                    <AssistantCard
                      key={message.id}
                      message={message}
                      slug={config.slug}
                      question={messages[index - 1]?.author === 'USER'
                        ? messages[index - 1]?.text ?? ''
                        : ''}
                      subqueries={messages[index - 1]?.author === 'USER'
                        ? messages[index - 1]?.subqueries ?? []
                        : []}
                      activeStage={index === messages.length - 1 ? activeStageLabel : null}
                      onRetry={() => retry(message.id)}
                      onFeedback={(good, text) => sendFeedback(message.id, good, text)}
                      onReanswerDeeply={() =>
                        reanswerDeeply(
                          messages[index - 1]?.author === 'USER'
                            ? messages[index - 1]?.text ?? ''
                            : '',
                          message.id,
                        )}
                      onAskSubquery={(subquery) => void send(subquery)}
                      onVerdicts={(verdicts) => saveVerdicts(message.id, verdicts)}
                    />
                  )
              )
            )}
          {isStreaming && activeStageLabel && messages[messages.length - 1]?.author === 'USER'
            ? (
              <div className='flex items-center gap-2 rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface px-4 py-3 text-xs font-medium text-ink-3 shadow-sm'>
                <span
                  className='h-1.5 w-1.5 animate-pulse rounded-full'
                  style={{ backgroundColor: 'var(--rp-accent)' }}
                  aria-hidden='true'
                />
                {activeStageLabel}
              </div>
            )
            : null}
          <div ref={threadEndRef} />
        </section>

        <form onSubmit={handleSubmit} className='mt-2 shrink-0'>
          <div className='mb-1.5 flex flex-wrap items-center gap-2 px-1'>
            <button
              type='button'
              onClick={() => setDeepResearch((prev) => !prev)}
              disabled={isStreaming}
              aria-pressed={deepResearch}
              className={`rp-chip h-9 sm:h-7 ${deepResearch ? 'rp-chip-active' : ''}`}
            >
              Deep research
            </button>
            {deepResearch
              ? (
                <span className='text-xs text-ink-3'>
                  Maps sub-questions before answering - slower, more thorough.
                </span>
              )
              : null}
          </div>
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
              className='max-h-40 min-w-0 flex-1 resize-none rounded-[var(--rp-radius)] border-0 bg-transparent px-3 py-2 text-sm text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none disabled:opacity-60'
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
