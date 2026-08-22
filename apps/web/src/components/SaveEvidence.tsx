import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addEvidence,
  createInvestigation,
  listInvestigations,
  type NewEvidence,
  saveArtefact,
} from '../api/client.ts'

// ---------------------------------------------------------------------------
// "Save to investigation" - the universal affordance that promotes a passage
// to Evidence. Renders as a quiet button; opens a picker of the client's
// investigations with inline creation. Used on search results, answer
// sources, evidence tables and the document reader.
// ---------------------------------------------------------------------------

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

  return (
    <div ref={rootRef} className='relative inline-block'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup='true'
        className={compact
          ? 'rp-btn rp-btn-ghost h-7 px-2 text-xs'
          : 'rp-btn rp-btn-outline h-8 px-2.5 text-xs'}
      >
        {label}
      </button>
      {open
        ? (
          <div
            role='dialog'
            aria-label='Save to investigation'
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
                <button
                  key={investigation.id}
                  type='button'
                  disabled={busy}
                  onClick={() => void saveTo(investigation.id, investigation.name)}
                  className='flex w-full items-center justify-between gap-2 rounded-[var(--rp-radius)] px-2 py-1.5 text-left text-sm text-ink hover:bg-[var(--rp-surface-2)]'
                >
                  <span className='truncate'>{investigation.name}</span>
                  <span className='shrink-0 text-xs text-ink-3'>{investigation.evidenceCount}</span>
                </button>
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
                void createAndSave()
              }}
            >
              <input
                type='text'
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
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
    <div ref={rootRef} className='relative inline-block'>
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup='true'
        className='rp-btn rp-btn-outline h-8 px-2.5 text-xs'
      >
        Save to investigation
      </button>
      {open
        ? (
          <div
            role='dialog'
            aria-label='Save artefact to investigation'
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
                <button
                  key={investigation.id}
                  type='button'
                  disabled={busy}
                  onClick={() => void saveTo(investigation.id, investigation.name)}
                  className='flex w-full items-center justify-between gap-2 rounded-[var(--rp-radius)] px-2 py-1.5 text-left text-sm text-ink hover:bg-[var(--rp-surface-2)]'
                >
                  <span className='truncate'>{investigation.name}</span>
                  <span className='shrink-0 text-xs text-ink-3'>{investigation.evidenceCount}</span>
                </button>
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
                void createAndSave()
              }}
            >
              <input
                type='text'
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
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
        : null}
    </div>
  )
}
