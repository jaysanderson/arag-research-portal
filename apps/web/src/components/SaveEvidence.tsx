import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addEvidence,
  createInvestigation,
  type InvestigationMeta,
  listInvestigations,
  type NewEvidence,
  saveArtefact,
} from '../api/client.ts'

// ---------------------------------------------------------------------------
// "Save to investigation" - the universal affordance that promotes a passage
// to Evidence. Renders as a quiet button; opens a picker of the client's
// investigations with inline creation. Used on search results, answer
// sources, evidence tables and the document reader.
//
// A tenant can also mark one investigation "current" (kept in localStorage,
// per browser). Once set, Save becomes a one-click action straight into it -
// the chevron alongside still opens the full picker to switch or start new.
// ---------------------------------------------------------------------------

export interface CurrentInvestigation {
  id: string
  name: string
}

const CURRENT_INVESTIGATION_EVENT = 'rp-current-investigation-change'

function currentInvestigationKey(slug: string): string {
  return `rp-current-investigation-${slug}`
}

/** Read the tenant's current investigation from localStorage - null if none is set. */
export function getCurrentInvestigation(slug: string): CurrentInvestigation | null {
  try {
    const raw = localStorage.getItem(currentInvestigationKey(slug))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed !== null && typeof parsed === 'object' &&
      typeof (parsed as { id?: unknown }).id === 'string' &&
      typeof (parsed as { name?: unknown }).name === 'string'
    ) {
      return parsed as CurrentInvestigation
    }
    return null
  } catch {
    return null
  }
}

/** Set (or clear, with null) the tenant's current investigation. */
export function setCurrentInvestigation(slug: string, value: CurrentInvestigation | null): void {
  try {
    if (value) localStorage.setItem(currentInvestigationKey(slug), JSON.stringify(value))
    else localStorage.removeItem(currentInvestigationKey(slug))
  } catch {
    // localStorage unavailable (private mode, quota) - current investigation is a
    // convenience, not critical, so fail quietly.
  }
  globalThis.dispatchEvent(new CustomEvent(CURRENT_INVESTIGATION_EVENT, { detail: { slug } }))
}

/**
 * Reactive read of the current investigation - every mounted instance updates
 * the moment any of them calls setCurrentInvestigation, so a badge here and a
 * toggle there never drift out of sync.
 */
export function useCurrentInvestigation(slug: string): CurrentInvestigation | null {
  const [current, setCurrent] = useState(() => getCurrentInvestigation(slug))

  useEffect(() => {
    setCurrent(getCurrentInvestigation(slug))
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ slug: string } | undefined>).detail
      if (!detail || detail.slug === slug) setCurrent(getCurrentInvestigation(slug))
    }
    globalThis.addEventListener(CURRENT_INVESTIGATION_EVENT, onChange)
    globalThis.addEventListener('storage', onChange)
    return () => {
      globalThis.removeEventListener(CURRENT_INVESTIGATION_EVENT, onChange)
      globalThis.removeEventListener('storage', onChange)
    }
  }, [slug])

  return current
}

function truncateName(name: string, max = 18): string {
  return name.length > max ? `${name.slice(0, Math.max(0, max - 1))}…` : name
}

function PinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className={className}>
      <path d='M9.69 18.933a.75.75 0 00.62 0c.204-.093.478-.227.797-.406.636-.357 1.48-.9 2.325-1.634C15.31 15.375 17 13.02 17 10a7 7 0 10-14 0c0 3.02 1.69 5.375 3.268 6.893.845.734 1.689 1.277 2.325 1.634.32.179.593.313.797.406zM10 11.5a2 2 0 110-4 2 2 0 010 4z' />
    </svg>
  )
}

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className={className}>
      <path
        fillRule='evenodd'
        d='M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.25a.75.75 0 01-1.06 0L5.21 8.29a.75.75 0 01.02-1.08z'
        clipRule='evenodd'
      />
    </svg>
  )
}

/**
 * The "make current" toggle. `variant='chip'` (default) is a labelled chip for
 * a card or a header; `variant='icon'` is a compact pin-only button for tight
 * rows such as picker entries.
 */
export function MakeCurrentToggle({
  slug,
  investigation,
  variant = 'chip',
  className,
}: {
  slug: string
  investigation: { id: string; name: string }
  variant?: 'chip' | 'icon'
  className?: string
}) {
  const current = useCurrentInvestigation(slug)
  const isCurrent = current?.id === investigation.id

  const toggle = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault()
    event.stopPropagation()
    setCurrentInvestigation(
      slug,
      isCurrent ? null : { id: investigation.id, name: investigation.name },
    )
  }

  if (variant === 'icon') {
    return (
      <button
        type='button'
        onClick={toggle}
        aria-pressed={isCurrent}
        title={isCurrent ? 'This is your current investigation' : 'Make current'}
        className={`rp-btn rp-btn-ghost h-7 w-7 shrink-0 p-0 ${
          isCurrent ? 'text-[var(--rp-accent)]' : 'text-ink-3'
        } ${className ?? ''}`}
      >
        <PinIcon className='h-3.5 w-3.5' />
        <span className='sr-only'>{isCurrent ? 'Current investigation' : 'Make current'}</span>
      </button>
    )
  }

  return (
    <button
      type='button'
      onClick={toggle}
      aria-pressed={isCurrent}
      className={`rp-chip ${isCurrent ? 'rp-chip-active' : ''} ${className ?? ''}`}
    >
      <PinIcon className='h-3.5 w-3.5' />
      {isCurrent ? 'Current ✓' : 'Make current'}
    </button>
  )
}

/** Shared picker body used by both save buttons below. */
function InvestigationPicker({
  slug,
  investigations,
  busy,
  error,
  newName,
  onNewNameChange,
  onPick,
  onCreate,
  ariaLabel,
}: {
  slug: string
  investigations: InvestigationMeta[] | undefined
  busy: boolean
  error: boolean
  newName: string
  onNewNameChange: (value: string) => void
  onPick: (investigationId: string, name: string) => void
  onCreate: () => void
  ariaLabel: string
}) {
  return (
    <div
      role='dialog'
      aria-label={ariaLabel}
      className='absolute right-0 z-30 mt-1 w-64 rounded-[var(--rp-radius)] border border-line bg-surface p-2 shadow-lg'
    >
      <p className='px-1 pb-1 text-xs font-medium uppercase tracking-wide text-ink-3'>
        Save to investigation
      </p>
      {error
        ? (
          <p className='px-1 pb-1 text-xs text-[var(--rp-bad-ink)]'>
            Could not save - try again.
          </p>
        )
        : null}
      <div className='max-h-44 overflow-y-auto'>
        {(investigations ?? []).filter((i) => i.status === 'active').map((investigation) => (
          <div key={investigation.id} className='flex items-center gap-0.5'>
            <button
              type='button'
              disabled={busy}
              onClick={() =>
                onPick(investigation.id, investigation.name)}
              className='flex min-w-0 flex-1 items-center justify-between gap-2 rounded-[var(--rp-radius)] px-2 py-1.5 text-left text-sm text-ink hover:bg-[var(--rp-surface-2)]'
            >
              <span className='truncate'>{investigation.name}</span>
              <span className='shrink-0 text-xs text-ink-3'>{investigation.evidenceCount}</span>
            </button>
            <MakeCurrentToggle slug={slug} investigation={investigation} variant='icon' />
          </div>
        ))}
        {investigations && investigations.length === 0
          ? (
            <p className='px-2 py-1.5 text-xs text-ink-3'>
              No investigations yet - start one below.
            </p>
          )
          : null}
      </div>
      <form
        className='mt-1 flex items-center gap-1 border-t border-line pt-2'
        onSubmit={(event) => {
          event.preventDefault()
          onCreate()
        }}
      >
        <input
          type='text'
          value={newName}
          onChange={(event) => onNewNameChange(event.target.value)}
          placeholder='New investigation…'
          aria-label='New investigation name'
          className='rp-input h-8 min-w-0 flex-1 text-xs'
        />
        <button
          type='submit'
          disabled={busy || newName.trim().length === 0}
          className='rp-btn rp-btn-primary h-8 shrink-0 px-2 text-xs'
        >
          {busy ? '…' : 'Create'}
        </button>
      </form>
    </div>
  )
}

export function SaveEvidenceButton({
  slug,
  evidence,
  compact = false,
  label = 'Save',
}: {
  slug: string
  evidence: NewEvidence
  compact?: boolean
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [newName, setNewName] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const queryClient = useQueryClient()
  const current = useCurrentInvestigation(slug)

  const { data: investigations } = useQuery({
    queryKey: ['investigations', slug],
    queryFn: () => listInvestigations(slug),
    enabled: open,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const saveTo = async (investigationId: string, name: string) => {
    setBusy(true)
    setError(false)
    try {
      await addEvidence(slug, investigationId, evidence)
      setSaved(name)
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['investigations', slug] })
      void queryClient.invalidateQueries({ queryKey: ['investigation', slug, investigationId] })
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const createAndSave = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError(false)
    try {
      const investigation = await createInvestigation(slug, {
        name,
        question: evidence.question,
      })
      setNewName('')
      await saveTo(investigation.id, investigation.name)
    } catch {
      setError(true)
      setBusy(false)
    }
  }

  if (saved) {
    return (
      <span
        className={`inline-flex items-center gap-1 text-xs text-[var(--rp-ok-ink)] ${
          compact ? '' : 'px-1'
        }`}
        role='status'
      >
        Saved to {saved}
      </span>
    )
  }

  const sizeClass = compact ? 'h-7 px-2 text-xs' : 'h-8 px-2.5 text-xs'

  return (
    <div ref={rootRef} className='relative inline-flex items-center gap-1'>
      {current
        ? (
          <button
            type='button'
            disabled={busy}
            title={current.name}
            onClick={() => void saveTo(current.id, current.name)}
            className={`rp-btn rp-btn-outline ${sizeClass}`}
          >
            {busy ? 'Saving…' : `Save → ${truncateName(current.name)}`}
          </button>
        )
        : (
          <button
            type='button'
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-haspopup='true'
            className={`rp-btn rp-btn-outline ${sizeClass}`}
          >
            {label}
          </button>
        )}
      {current
        ? (
          <button
            type='button'
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-haspopup='true'
            aria-label='Choose a different investigation'
            title='Choose a different investigation'
            className={`rp-btn rp-btn-outline px-1.5 ${compact ? 'h-7' : 'h-8'}`}
          >
            <ChevronDownIcon className='h-3.5 w-3.5' />
          </button>
        )
        : null}
      {open
        ? (
          <InvestigationPicker
            slug={slug}
            investigations={investigations}
            busy={busy}
            error={error}
            newName={newName}
            onNewNameChange={setNewName}
            onPick={(id, name) => void saveTo(id, name)}
            onCreate={() => void createAndSave()}
            ariaLabel='Save to investigation'
          />
        )
        : null}
    </div>
  )
}

/**
 * "Save to investigation" for generated artefacts - same picker, but stores
 * the artefact payload (kind + data) instead of an evidence passage.
 */
export function SaveArtefactButton({
  slug,
  artefact,
}: {
  slug: string
  artefact: { kind: string; title: string; data: unknown }
}) {
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [newName, setNewName] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const queryClient = useQueryClient()
  const current = useCurrentInvestigation(slug)

  const { data: investigations } = useQuery({
    queryKey: ['investigations', slug],
    queryFn: () => listInvestigations(slug),
    enabled: open,
    staleTime: 30_000,
  })

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const saveTo = async (investigationId: string, name: string) => {
    setBusy(true)
    setError(false)
    try {
      await saveArtefact(slug, investigationId, artefact)
      setSaved(name)
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['investigations', slug] })
      void queryClient.invalidateQueries({ queryKey: ['investigation', slug, investigationId] })
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const createAndSave = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError(false)
    try {
      const investigation = await createInvestigation(slug, { name })
      setNewName('')
      await saveTo(investigation.id, investigation.name)
    } catch {
      setError(true)
      setBusy(false)
    }
  }

  if (saved) {
    return (
      <span
        className='inline-flex items-center gap-1 px-1 text-xs text-[var(--rp-ok-ink)]'
        role='status'
      >
        Saved to {saved}
      </span>
    )
  }

  return (
    <div ref={rootRef} className='relative inline-flex items-center gap-1'>
      {current
        ? (
          <button
            type='button'
            disabled={busy}
            title={current.name}
            onClick={() => void saveTo(current.id, current.name)}
            className='rp-btn rp-btn-outline h-8 px-2.5 text-xs'
          >
            {busy ? 'Saving…' : `Save → ${truncateName(current.name)}`}
          </button>
        )
        : (
          <button
            type='button'
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-haspopup='true'
            className='rp-btn rp-btn-outline h-8 px-2.5 text-xs'
          >
            Save to investigation
          </button>
        )}
      {current
        ? (
          <button
            type='button'
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-haspopup='true'
            aria-label='Choose a different investigation'
            title='Choose a different investigation'
            className='rp-btn rp-btn-outline h-8 px-1.5'
          >
            <ChevronDownIcon className='h-3.5 w-3.5' />
          </button>
        )
        : null}
      {open
        ? (
          <InvestigationPicker
            slug={slug}
            investigations={investigations}
            busy={busy}
            error={error}
            newName={newName}
            onNewNameChange={setNewName}
            onPick={(id, name) => void saveTo(id, name)}
            onCreate={() => void createAndSave()}
            ariaLabel='Save artefact to investigation'
          />
        )
        : null}
    </div>
  )
}
