import { type FormEvent, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ApiError, getAdminOverview } from '../api/client.ts'
import { ErrorCard, Skeleton } from '../components/ui.tsx'
import { AddPortal } from './admin/AddPortal.tsx'
import { MigratePanel } from './admin/MigratePanel.tsx'
import { PortalRow } from './admin/PortalRow.tsx'
import { inputClass } from './admin/shared.ts'

/**
 * The management surface: passcode-gated overview of every portal, its
 * knowledge box connection, and the controls to connect, replace or revert.
 * The passcode lives in sessionStorage for the tab, never anywhere else.
 *
 * Portals render as a compact accordion - one collapsed summary row each,
 * with only one expanded at a time - so the whole overview fits a single
 * viewport rather than one long scroll.
 */
export function AdminPage() {
  const [passcode, setPasscode] = useState(() => sessionStorage.getItem('rp-admin-passcode') ?? '')
  const [draft, setDraft] = useState('')
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null)
  // Pre-release convenience: the server can offer a passcode to prefill
  // (ADMIN_PASSCODE_PREFILL env); nothing is baked into the bundle.
  useEffect(() => {
    if (draft) return
    fetch('/api/admin-prefill')
      .then((r) => r.json())
      .then((d: { passcode?: string }) => {
        if (d.passcode) setDraft(d.passcode)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['admin-overview'],
    queryFn: () => getAdminOverview(passcode),
    enabled: passcode.length > 0,
    retry: false,
  })

  const unauthorised = isError && error instanceof ApiError && error.status === 401

  const submitPasscode = (event: FormEvent) => {
    event.preventDefault()
    sessionStorage.setItem('rp-admin-passcode', draft)
    setPasscode(draft)
  }

  if (!passcode || unauthorised) {
    return (
      <main className='flex min-h-screen flex-col items-center justify-center bg-[#f7f7f5] px-6'>
        <div className='w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm'>
          <p className='text-xs font-semibold uppercase tracking-[0.2em] text-neutral-400'>
            Research portal
          </p>
          <h1 className='mt-1 text-xl font-semibold tracking-tight text-neutral-900'>
            Administration
          </h1>
          <form onSubmit={submitPasscode} className='mt-5 space-y-4'>
            <div>
              <label
                htmlFor='admin-passcode'
                className='mb-1.5 block text-sm font-medium text-neutral-900'
              >
                Admin passcode
              </label>
              <input
                id='admin-passcode'
                type='password'
                className={inputClass}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoComplete='off'
                required
              />
            </div>
            {unauthorised && (
              <p role='alert' className='text-sm text-rose-700'>
                That passcode was not accepted.
              </p>
            )}
            <button
              type='submit'
              className='w-full rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800'
            >
              Enter
            </button>
          </form>
          <Link
            to='/'
            className='mt-4 inline-block text-sm text-neutral-500 transition-colors duration-150 hover:text-neutral-900'
          >
            &larr; Back to portals
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className='min-h-screen bg-[#f7f7f5]'>
      <div className='mx-auto max-w-3xl px-6 py-12'>
        <div className='flex items-center justify-between'>
          <div>
            <p className='text-xs font-semibold uppercase tracking-[0.2em] text-neutral-400'>
              Research portal
            </p>
            <h1 className='mt-1 text-2xl font-semibold tracking-tight text-neutral-900'>
              Administration
            </h1>
          </div>
          <Link
            to='/'
            className='text-sm font-medium text-neutral-500 transition-colors duration-150 hover:text-neutral-900'
          >
            &larr; Back to portals
          </Link>
        </div>

        {isLoading && (
          <div className='mt-8 space-y-3'>
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-16 w-full' />
          </div>
        )}

        {isError && !unauthorised && (
          <div className='mt-8'>
            <ErrorCard
              message={error instanceof Error ? error.message : 'Could not load the overview.'}
              onRetry={() => void refetch()}
            />
          </div>
        )}

        {data && (
          <div className='mt-8 space-y-4'>
            <AddPortal passcode={passcode} />

            <div className='space-y-3'>
              {data.map((row) => (
                <PortalRow
                  key={row.tenant.slug}
                  row={row}
                  passcode={passcode}
                  expanded={expandedSlug === row.tenant.slug}
                  onToggleExpanded={() =>
                    setExpandedSlug((prev) => (prev === row.tenant.slug ? null : row.tenant.slug))}
                />
              ))}
            </div>

            <MigratePanel rows={data} passcode={passcode} />
          </div>
        )}
      </div>
    </main>
  )
}
