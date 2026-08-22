import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import {
  ApiError,
  deleteEvidence,
  deleteInvestigation,
  type EvidenceItem,
  type EvidenceVerdict,
  getInvestigation,
  type Investigation,
  type InvestigationArtefact,
  updateEvidence,
  updateInvestigation,
} from '../api/client.ts'
import { EmptyState, ErrorCard, Skeleton } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// Investigation detail - the heart of the research workspace. A named
// question, a notebook, an accumulating evidence list with per-item verdicts,
// and whatever artefacts other tools have saved into it. Everything here
// writes straight through the typed client; the whole investigation is one
// query (['investigation', slug, id]) so any mutation just invalidates it.
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString('en-AU', { year: 'numeric', month: 'short', day: 'numeric' })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// --- Editable text field: click to reveal a pencil, click to edit inline ----

function EditableField({
  value,
  placeholder,
  ariaLabel,
  onSave,
  className,
}: {
  value: string
  placeholder: string
  ariaLabel: string
  onSave: (next: string) => void
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next !== value.trim()) onSave(next)
  }

  const cancel = () => {
    setDraft(value)
    setEditing(false)
  }

  if (editing) {
    return (
      <input
        autoFocus
        aria-label={ariaLabel}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') cancel()
        }}
        onBlur={commit}
        placeholder={placeholder}
        className={`rp-input ${className ?? ''}`}
      />
    )
  }

  return (
    <button
      type='button'
      onClick={() => setEditing(true)}
      className='rp-focus group flex min-w-0 max-w-full items-center gap-1.5 rounded-[6px] text-left'
    >
      <span className={`truncate ${value ? '' : 'italic text-ink-3'} ${className ?? ''}`}>
        {value || placeholder}
      </span>
      <svg
        viewBox='0 0 20 20'
        fill='currentColor'
        aria-hidden='true'
        className='h-3.5 w-3.5 shrink-0 text-ink-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100'
      >
        <path d='M14.69 2.86a1.5 1.5 0 012.12 0l.33.33a1.5 1.5 0 010 2.12L7.56 14.89l-3.02.67a.5.5 0 01-.6-.6l.67-3.02L14.69 2.86z' />
      </svg>
    </button>
  )
}

// --- A two-click confirm, no window.confirm ---------------------------------

function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  disabled,
  className,
  confirmClassName,
}: {
  label: string
  confirmLabel: string
  onConfirm: () => void
  disabled?: boolean
  className?: string
  confirmClassName?: string
}) {
  const [confirming, setConfirming] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  if (confirming) {
    return (
      <button
        type='button'
        disabled={disabled}
        onClick={() => {
          if (timerRef.current) clearTimeout(timerRef.current)
          setConfirming(false)
          onConfirm()
        }}
        className={confirmClassName ?? 'rp-btn rp-btn-danger'}
      >
        {confirmLabel}
      </button>
    )
  }

  return (
    <button
      type='button'
      disabled={disabled}
      onClick={() => {
        setConfirming(true)
        timerRef.current = setTimeout(() => setConfirming(false), 4000)
      }}
      className={className ?? 'rp-btn rp-btn-outline'}
    >
      {label}
    </button>
  )
}

// --- Header: name, question, status, ask, delete ----------------------------

function InvestigationHeader(
  { slug, investigation }: { slug: string; investigation: Investigation },
) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const patch = useMutation({
    mutationFn: (input: { name?: string; question?: string; status?: 'active' | 'closed' }) =>
      updateInvestigation(slug, investigation.id, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['investigation', slug, investigation.id] })
      void queryClient.invalidateQueries({ queryKey: ['investigations', slug] })
    },
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteInvestigation(slug, investigation.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['investigations', slug] })
      navigate(`/t/${slug}/investigations`)
    },
  })

  return (
    <div className='rp-card p-5'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div className='min-w-0 flex-1'>
          <EditableField
            value={investigation.name}
            placeholder='Untitled investigation'
            ariaLabel='Investigation name'
            onSave={(name) => {
              if (name.length > 0) patch.mutate({ name })
            }}
            className='text-xl font-semibold tracking-tight text-ink'
          />
          <div className='mt-1.5'>
            <EditableField
              value={investigation.question}
              placeholder='No research question set - click to add one'
              ariaLabel='Research question'
              onSave={(question) => patch.mutate({ question })}
              className='text-sm text-ink-2'
            />
          </div>
        </div>
        <span className='shrink-0'>
          {investigation.status === 'active'
            ? <span className='rp-badge rp-badge-ok'>Active</span>
            : <span className='rp-badge rp-badge-quiet'>Closed</span>}
        </span>
      </div>

      <div className='mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4'>
        {investigation.question.length > 0
          ? (
            <Link
              to={`/t/${slug}/assistant?ask=${encodeURIComponent(investigation.question)}`}
              className='rp-btn rp-btn-primary'
            >
              Ask this question
            </Link>
          )
          : null}
        <button
          type='button'
          disabled={patch.isPending}
          onClick={() =>
            patch.mutate({ status: investigation.status === 'active' ? 'closed' : 'active' })}
          className='rp-btn rp-btn-outline'
        >
          {investigation.status === 'active' ? 'Close investigation' : 'Reopen investigation'}
        </button>
        <div className='ml-auto'>
          <ConfirmButton
            label='Delete'
            confirmLabel='Confirm delete'
            disabled={removeMutation.isPending}
            onConfirm={() => removeMutation.mutate()}
            className='rp-btn rp-btn-ghost text-[var(--rp-bad-ink)]'
            confirmClassName='rp-btn rp-btn-danger'
          />
        </div>
      </div>
    </div>
  )
}

// --- Notebook: debounced free-form notes ------------------------------------

function NotebookSection({ slug, investigation }: { slug: string; investigation: Investigation }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(investigation.notes)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadedIdRef = useRef(investigation.id)

  // Only resync the draft when we've switched to a different investigation -
  // never on our own refetch, or the user's in-flight typing would be wiped.
  useEffect(() => {
    if (loadedIdRef.current !== investigation.id) {
      loadedIdRef.current = investigation.id
      setDraft(investigation.notes)
      setStatus('idle')
    }
  }, [investigation.id, investigation.notes])

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const mutation = useMutation({
    mutationFn: (notes: string) => updateInvestigation(slug, investigation.id, { notes }),
    onSuccess: () => {
      setStatus('saved')
      void queryClient.invalidateQueries({ queryKey: ['investigation', slug, investigation.id] })
    },
  })

  const onChange = (value: string) => {
    setDraft(value)
    setStatus('saving')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => mutation.mutate(value), 1500)
  }

  return (
    <section className='rp-card p-5'>
      <div className='flex items-center justify-between gap-3'>
        <h2 className='text-sm font-semibold text-ink'>Notebook</h2>
        <span aria-live='polite' className='text-xs text-ink-3'>
          {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : ''}
        </span>
      </div>
      <textarea
        rows={6}
        value={draft}
        onChange={(event) => onChange(event.target.value)}
        placeholder='Working notes, hunches, things still to check…'
        className='rp-input mt-3'
      />
    </section>
  )
}

// --- Evidence: verdict chips, colour-coded --------------------------------

const VERDICTS: { id: EvidenceVerdict; label: string }[] = [
  { id: 'supports', label: 'Supports' },
  { id: 'partial', label: 'Partial' },
  { id: 'not-relevant', label: 'Not relevant' },
  { id: 'contradicts', label: 'Contradicts' },
]

function verdictLabel(verdict: EvidenceVerdict | null): string {
  if (!verdict) return 'Not assessed'
  return VERDICTS.find((v) => v.id === verdict)?.label ?? verdict
}

function verdictChipStyle(id: EvidenceVerdict, active: boolean): CSSProperties {
  if (!active) return {}
  switch (id) {
    case 'supports':
      return {
        borderColor: 'var(--rp-ok-line)',
        background: 'var(--rp-ok-bg)',
        color: 'var(--rp-ok-ink)',
      }
    case 'contradicts':
      return {
        borderColor: 'var(--rp-bad-line)',
        background: 'var(--rp-bad-bg)',
        color: 'var(--rp-bad-ink)',
      }
    case 'partial':
      return {
        borderColor: 'var(--rp-warn-line)',
        background: 'var(--rp-warn-bg)',
        color: 'var(--rp-warn-ink)',
      }
    case 'not-relevant':
      return {
        borderColor: 'var(--rp-line)',
        background: 'var(--rp-surface-2)',
        color: 'var(--rp-ink-3)',
      }
  }
}

function EvidenceCard(
  { slug, investigationId, item }: { slug: string; investigationId: string; item: EvidenceItem },
) {
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [note, setNote] = useState(item.note)
  const [noteDirty, setNoteDirty] = useState(false)
  const noteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
  }, [])

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['investigation', slug, investigationId] })

  const verdictMutation = useMutation({
    mutationFn: (verdict: EvidenceVerdict) =>
      updateEvidence(slug, investigationId, item.id, { verdict }),
    onSuccess: invalidate,
  })

  const noteMutation = useMutation({
    mutationFn: (nextNote: string) =>
      updateEvidence(slug, investigationId, item.id, { note: nextNote }),
    onSuccess: () => {
      setNoteDirty(false)
      invalidate()
    },
  })

  const removeMutation = useMutation({
    mutationFn: () => deleteEvidence(slug, investigationId, item.id),
    onSuccess: invalidate,
  })

  const onNoteChange = (value: string) => {
    setNote(value)
    setNoteDirty(true)
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current)
    noteTimerRef.current = setTimeout(() => noteMutation.mutate(value), 1500)
  }

  const sourceHref = `/t/${slug}/library/${encodeURIComponent(item.resourceId)}?passage=${
    encodeURIComponent(item.passage.slice(0, 200))
  }`

  return (
    <div className='rp-card p-4'>
      <div className='flex items-start justify-between gap-3'>
        <Link
          to={sourceHref}
          className='rp-focus min-w-0 truncate text-sm font-semibold text-ink underline-offset-2 hover:underline'
          title={item.resourceTitle}
        >
          {item.resourceTitle}
        </Link>
        {item.score != null
          ? (
            <span className='rp-badge rp-badge-quiet shrink-0 tabular-nums'>
              {Math.round(item.score * 100)}%
            </span>
          )
          : null}
      </div>

      <blockquote
        className={`mt-2 border-l-2 border-line pl-3 text-sm leading-relaxed text-ink-2 ${
          expanded ? '' : 'rp-clamp-4'
        }`}
      >
        {item.passage}
      </blockquote>
      {item.passage.length > 220
        ? (
          <button
            type='button'
            onClick={() => setExpanded((e) => !e)}
            className='mt-1 text-xs font-medium text-ink-3 hover:text-ink'
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )
        : null}

      {item.question
        ? (
          <p className='mt-2 text-xs italic text-ink-3'>
            Retrieved for &ldquo;{item.question}&rdquo;
          </p>
        )
        : null}
      {item.aiRelevance ? <p className='mt-1 text-xs text-ink-2'>{item.aiRelevance}</p> : null}

      <div className='mt-3 flex flex-wrap gap-1.5' role='group' aria-label='Verdict'>
        {VERDICTS.map((v) => {
          const active = item.verdict === v.id
          return (
            <button
              key={v.id}
              type='button'
              aria-pressed={active}
              disabled={verdictMutation.isPending}
              onClick={() => verdictMutation.mutate(v.id)}
              style={verdictChipStyle(v.id, active)}
              className='rp-chip'
            >
              {v.label}
            </button>
          )
        })}
      </div>

      <div className='mt-3 flex items-center gap-2'>
        <input
          type='text'
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder='Add a note…'
          aria-label={`Note for ${item.resourceTitle}`}
          className='rp-input h-8 text-xs'
        />
        {noteMutation.isPending || noteDirty
          ? <span className='shrink-0 text-xs text-ink-3'>Saving…</span>
          : null}
      </div>

      <div className='mt-3 flex items-center justify-between gap-3 border-t border-line pt-2.5'>
        <span className='text-xs text-ink-3'>Added {formatDate(item.createdAt)}</span>
        <ConfirmButton
          label='Remove'
          confirmLabel='Confirm remove'
          disabled={removeMutation.isPending}
          onConfirm={() => removeMutation.mutate()}
          className='rp-btn rp-btn-ghost h-7 px-2 text-xs'
          confirmClassName='rp-btn rp-btn-danger h-7 px-2 text-xs'
        />
      </div>
    </div>
  )
}

// --- Artefacts: read-only, tolerant of whatever shape lands here ------------

function ArtefactRow({ artefact }: { artefact: InvestigationArtefact }) {
  const isViewableObject = artefact.data !== null && typeof artefact.data === 'object'

  return (
    <div className='rounded-[var(--rp-radius)] border border-line p-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex min-w-0 items-center gap-2'>
          <span className='rp-badge rp-badge-quiet shrink-0 uppercase tracking-[0.06em]'>
            {artefact.kind}
          </span>
          <span className='truncate text-sm font-medium text-ink'>{artefact.title}</span>
        </div>
        <span className='shrink-0 text-xs text-ink-3'>{formatDate(artefact.createdAt)}</span>
      </div>
      {isViewableObject
        ? (
          <details className='mt-2'>
            <summary className='cursor-pointer text-xs font-medium text-ink-3 hover:text-ink'>
              View
            </summary>
            <pre className='mt-2 max-h-72 overflow-auto rounded-[var(--rp-radius)] bg-surface-2 p-3 text-xs text-ink-2'>
              {JSON.stringify(artefact.data, null, 2)}
            </pre>
          </details>
        )
        : null}
    </div>
  )
}

// --- Export to Word: the audit's "outputs with references intact" ----------

function investigationToHtml(investigation: Investigation): { title: string; bodyHtml: string } {
  const title = investigation.name || 'Investigation'

  const questionHtml = investigation.question
    ? `<h2>Research question</h2><p>${escapeHtml(investigation.question)}</p>`
    : ''
  const notesHtml = investigation.notes.trim().length > 0
    ? `<h2>Notes</h2><p>${escapeHtml(investigation.notes).replace(/\n/g, '<br>')}</p>`
    : ''

  const sorted = [...investigation.evidence].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  const sourceTitles = Array.from(new Set(sorted.map((e) => e.resourceTitle)))

  const evidenceHtml = sorted.length > 0
    ? `<h2>Evidence</h2>${
      sorted
        .map((item) => {
          const refIndex = sourceTitles.indexOf(item.resourceTitle) + 1
          const scoreText = item.score != null ? `${Math.round(item.score * 100)}%` : 'n/a'
          const noteHtml = item.note.trim().length > 0
            ? `<p><em>Note:</em> ${escapeHtml(item.note)}</p>`
            : ''
          return `<blockquote>${escapeHtml(item.passage)}</blockquote>` +
            `<p><strong>Source:</strong> ${escapeHtml(item.resourceTitle)} [${refIndex}] &nbsp; ` +
            `<strong>Score:</strong> ${scoreText} &nbsp; ` +
            `<strong>Verdict:</strong> ${escapeHtml(verdictLabel(item.verdict))}</p>${noteHtml}`
        })
        .join('')
    }`
    : '<h2>Evidence</h2><p>No evidence recorded.</p>'

  const referencesHtml = sourceTitles.length > 0
    ? `<h2>References</h2><ol>${sourceTitles.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ol>`
    : ''

  return { title, bodyHtml: `${questionHtml}${notesHtml}${evidenceHtml}${referencesHtml}` }
}

/** Word-compatible HTML document shell - opens cleanly as a .doc in Word. */
function wordDocumentHtml(title: string, bodyHtml: string): string {
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
h1 { font-size: 22pt; margin-bottom: 12pt; }
h2 { font-size: 14pt; margin-top: 18pt; margin-bottom: 6pt; }
blockquote { margin: 8pt 0; padding: 6pt 12pt; border-left: 3px solid #cccccc; color: #333333; font-style: italic; }
ol, ul { margin: 6pt 0; padding-left: 22pt; }
p { margin: 6pt 0; font-size: 11pt; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body>
</html>`
}

/** Filename-safe slug of a title, falling back to today's date when the title is empty. */
function slugOrDate(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
  return slug.length > 0 ? slug.slice(0, 60) : new Date().toISOString().slice(0, 10)
}

function exportInvestigationToWord(investigation: Investigation) {
  const { title, bodyHtml } = investigationToHtml(investigation)
  const html = wordDocumentHtml(title, bodyHtml)
  const blob = new Blob(['﻿', html], { type: 'application/msword' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `investigation-${slugOrDate(title)}.doc`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------

const VERDICT_FILTERS = ['all', 'supports', 'partial', 'contradicts', 'not-relevant'] as const
type VerdictFilter = typeof VERDICT_FILTERS[number]

export function InvestigationDetailPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const { id } = useParams<{ id: string }>()
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all')

  const {
    data: investigation,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['investigation', config.slug, id],
    queryFn: () => getInvestigation(config.slug, id ?? ''),
    enabled: Boolean(id),
  })

  if (isLoading) {
    return (
      <main className='mx-auto max-w-3xl px-6 py-10'>
        <div className='space-y-3'>
          <Skeleton className='h-32 w-full' />
          <Skeleton className='h-40 w-full' />
          <Skeleton className='h-24 w-full' />
        </div>
      </main>
    )
  }

  if (isError || !investigation) {
    const notFound = error instanceof ApiError && error.status === 404
    return (
      <main className='mx-auto max-w-3xl px-6 py-10'>
        <ErrorCard
          message={notFound
            ? 'This investigation does not exist or has been removed.'
            : error instanceof Error
            ? error.message
            : 'Could not load this investigation.'}
          onRetry={() => void refetch()}
        />
        <Link to={`/t/${config.slug}/investigations`} className='rp-btn rp-btn-outline mt-4'>
          Back to investigations
        </Link>
      </main>
    )
  }

  const sortedEvidence = [...investigation.evidence].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  const counts: Record<VerdictFilter, number> = {
    all: sortedEvidence.length,
    supports: sortedEvidence.filter((e) => e.verdict === 'supports').length,
    partial: sortedEvidence.filter((e) => e.verdict === 'partial').length,
    contradicts: sortedEvidence.filter((e) => e.verdict === 'contradicts').length,
    'not-relevant': sortedEvidence.filter((e) => e.verdict === 'not-relevant').length,
  }
  const filteredEvidence = verdictFilter === 'all'
    ? sortedEvidence
    : sortedEvidence.filter((e) => e.verdict === verdictFilter)

  return (
    <main className='mx-auto max-w-3xl px-6 py-10'>
      <Link to={`/t/${config.slug}/investigations`} className='text-sm text-ink-3 hover:text-ink'>
        &larr; Investigations
      </Link>

      <div className='mt-3'>
        <InvestigationHeader slug={config.slug} investigation={investigation} />
      </div>

      <div className='mt-6'>
        <NotebookSection slug={config.slug} investigation={investigation} />
      </div>

      <section className='mt-6'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <h2 className='text-sm font-semibold text-ink'>
            Evidence <span className='font-normal text-ink-3'>({sortedEvidence.length})</span>
          </h2>
          <button
            type='button'
            disabled={sortedEvidence.length === 0}
            onClick={() => exportInvestigationToWord(investigation)}
            className='rp-btn rp-btn-outline disabled:cursor-not-allowed'
          >
            Export to Word
          </button>
        </div>

        {sortedEvidence.length > 0
          ? (
            <div className='mt-3 flex flex-wrap gap-1.5'>
              {VERDICT_FILTERS.map((f) => (
                <button
                  key={f}
                  type='button'
                  aria-pressed={verdictFilter === f}
                  onClick={() => setVerdictFilter(f)}
                  className={`rp-chip ${verdictFilter === f ? 'rp-chip-active' : ''}`}
                >
                  {f === 'all' ? 'All' : verdictLabel(f)} ({counts[f]})
                </button>
              ))}
            </div>
          )
          : null}

        <div className='mt-4'>
          {sortedEvidence.length === 0
            ? (
              <EmptyState
                title='No evidence yet'
                description="Save passages from Search, the Assistant's sources, or the document reader."
              />
            )
            : filteredEvidence.length === 0
            ? (
              <EmptyState
                title='No evidence matches this filter'
                description='Try a different verdict, or choose All to see everything.'
              />
            )
            : (
              <div className='space-y-3'>
                {filteredEvidence.map((item) => (
                  <EvidenceCard
                    key={item.id}
                    slug={config.slug}
                    investigationId={investigation.id}
                    item={item}
                  />
                ))}
              </div>
            )}
        </div>
      </section>

      <section className='mt-6'>
        <h2 className='text-sm font-semibold text-ink'>
          Artefacts{' '}
          <span className='font-normal text-ink-3'>({investigation.artefacts.length})</span>
        </h2>
        <div className='mt-3'>
          {investigation.artefacts.length === 0
            ? (
              <EmptyState
                title='No artefacts yet'
                description='Outputs saved from Generate and other tools will appear here.'
              />
            )
            : (
              <div className='space-y-2'>
                {investigation.artefacts.map((artefact) => (
                  <ArtefactRow key={artefact.id} artefact={artefact} />
                ))}
              </div>
            )}
        </div>
      </section>
    </main>
  )
}
