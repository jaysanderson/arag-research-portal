import { type FormEvent, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { AdminTenantOverview } from '@research-portal/core'
import {
  ApiError,
  connectKnowledgeBox,
  getAdminOverview,
  removePortal,
  revertKnowledgeBox,
  setPortalDisabled,
} from '../api/client.ts'
import { ErrorCard, Skeleton } from '../components/ui.tsx'
import { AddContent } from './admin/AddContent.tsx'
import { AddPortal } from './admin/AddPortal.tsx'
import { AnalysePanel } from './admin/AnalysePanel.tsx'
import { CreateKbBox } from './admin/CreateKbBox.tsx'
import { MessagePanel } from './admin/MessagePanel.tsx'
import { MigratePanel } from './admin/MigratePanel.tsx'
import { RecentList } from './admin/RecentList.tsx'
import { inputClass } from './admin/shared.ts'
import { StatTiles } from './admin/StatTiles.tsx'

function StatusBadge({ status }: { status: AdminTenantOverview['knowledgeBox']['status'] }) {
  if (status === 'connected') {
    return (
      <span className='inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800'>
        Connected
      </span>
    )
  }
  if (status === 'demo') {
    return (
      <span className='inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800'>
        Demo only
      </span>
    )
  }
  return (
    <span className='inline-flex items-center rounded-full border border-neutral-300 bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600'>
      Not connected
    </span>
  )
}

function TenantCard({ row, passcode }: { row: AdminTenantOverview; passcode: string }) {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const reachable = row.resourceCount !== null

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-overview'] })

  const onContentAdded = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-recent', row.tenant.slug] }),
      queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
      queryClient.invalidateQueries({ queryKey: ['admin-counters', row.tenant.slug] }),
    ])

  const onConnect = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const outcome = await connectKnowledgeBox(row.tenant.slug, { url, token, passcode })
      setUrl('')
      setToken('')
      setMessage({
        tone: 'ok',
        text: `Connected - the knowledge box responded with ${outcome.resourceCount} ${
          outcome.resourceCount === 1 ? 'resource' : 'resources'
        }.`,
      })
      await refresh()
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Connection failed - please try again.',
      })
    } finally {
      setBusy(false)
    }
  }

  const onToggleDisabled = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await setPortalDisabled(row.tenant.slug, passcode, !row.disabled)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['tenants'] }),
      ])
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Could not update the portal.',
      })
    } finally {
      setBusy(false)
    }
  }

  const onRemove = async () => {
    if (!globalThis.confirm(`Remove the '${row.tenant.productName}' portal from the app?`)) return
    setBusy(true)
    setMessage(null)
    try {
      await removePortal(row.tenant.slug, passcode)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['tenants'] }),
      ])
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Could not remove the portal.',
      })
      setBusy(false)
    }
  }

  const onRevert = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await revertKnowledgeBox(row.tenant.slug, passcode)
      setMessage({ tone: 'ok', text: 'Reverted to the demo knowledge box.' })
      await refresh()
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Could not revert - please try again.',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h2 className='text-lg font-semibold tracking-tight text-neutral-900'>
            {row.tenant.productName}
          </h2>
          <p className='text-sm text-neutral-500'>{row.tenant.organisation}</p>
        </div>
        <div className='flex items-center gap-3'>
          <StatusBadge status={row.knowledgeBox.status} />
          <button
            type='button'
            disabled={busy}
            onClick={onToggleDisabled}
            className='text-sm font-medium text-neutral-500 transition-colors duration-150 hover:text-neutral-900 disabled:opacity-60'
            title={row.disabled
              ? 'Show this portal in the switcher and portal list again'
              : 'Hide this portal from the switcher and portal list'}
          >
            {row.disabled ? 'Enable' : 'Disable'}
          </button>
          {row.custom && (
            <button
              type='button'
              disabled={busy}
              onClick={onRemove}
              className='text-sm font-medium text-rose-500 transition-colors duration-150 hover:text-rose-700 disabled:opacity-60'
              title='Removes this portal from the app - the knowledge box itself is untouched'
            >
              Remove
            </button>
          )}
          <Link
            to={`/t/${row.tenant.slug}`}
            className='text-sm font-medium text-neutral-500 transition-colors duration-150 hover:text-neutral-900'
          >
            Open portal &rarr;
          </Link>
        </div>
      </div>

      <dl className='mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2'>
        <div className='rounded-xl bg-neutral-50 px-4 py-3'>
          <dt className='text-xs font-medium uppercase tracking-wide text-neutral-500'>
            Knowledge box
          </dt>
          <dd className='mt-1 font-mono text-neutral-900'>
            {row.knowledgeBox.kbId ?? 'none'}
          </dd>
        </div>
        <div className='rounded-xl bg-neutral-50 px-4 py-3'>
          <dt className='text-xs font-medium uppercase tracking-wide text-neutral-500'>
            Documents
          </dt>
          <dd className='mt-1 text-neutral-900'>
            {row.resourceCount === null ? 'unreachable' : row.resourceCount}
          </dd>
        </div>
      </dl>

      {reachable && (
        <StatTiles
          slug={row.tenant.slug}
          passcode={passcode}
          resourceCount={row.resourceCount ?? 0}
        />
      )}

      <CreateKbBox row={row} passcode={passcode} onCreated={refresh} />

      {reachable && <AnalysePanel slug={row.tenant.slug} passcode={passcode} />}

      <form onSubmit={onConnect} className='mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2'>
        <div>
          <label
            htmlFor={`kb-id-${row.tenant.slug}`}
            className='mb-1.5 block text-sm font-medium text-neutral-900'
          >
            {row.knowledgeBox.status === 'connected'
              ? 'Replace with knowledge box endpoint'
              : 'Knowledge box API endpoint'}
          </label>
          <input
            id={`kb-id-${row.tenant.slug}`}
            className={inputClass}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder='https://<region>.rag.progress.cloud/api/v1/kb/<box-id>'
            autoComplete='off'
            required
          />
        </div>
        <div>
          <label
            htmlFor={`kb-token-${row.tenant.slug}`}
            className='mb-1.5 block text-sm font-medium text-neutral-900'
          >
            Service account API key
          </label>
          <input
            id={`kb-token-${row.tenant.slug}`}
            type='password'
            className={inputClass}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder='Paste the service account key'
            autoComplete='off'
            required
          />
        </div>
        <div className='flex items-center gap-3 sm:col-span-2'>
          <button
            type='submit'
            disabled={busy}
            className='inline-flex items-center rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800 disabled:opacity-60'
          >
            {busy ? 'Working…' : 'Verify and connect'}
          </button>
          {row.knowledgeBox.status === 'connected' && (
            <button
              type='button'
              disabled={busy}
              onClick={onRevert}
              className='inline-flex items-center rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-medium text-neutral-700 transition-colors duration-150 hover:bg-neutral-100 disabled:opacity-60'
            >
              Revert to demo box
            </button>
          )}
        </div>
      </form>
      <p className='mt-2 text-xs text-neutral-500'>
        The connection is verified against the live platform before it is saved. Tokens are stored
        server-side only.
      </p>

      {message && <MessagePanel message={message} className='mt-4' />}

      {reachable && (
        <>
          <AddContent slug={row.tenant.slug} passcode={passcode} onAdded={onContentAdded} />
          <RecentList slug={row.tenant.slug} passcode={passcode} />
        </>
      )}
    </section>
  )
}

/**
 * The management surface: passcode-gated overview of every portal, its
 * knowledge box connection, and the controls to connect, replace or revert.
 * The passcode lives in sessionStorage for the tab, never anywhere else.
 */
export function AdminPage() {
  const [passcode, setPasscode] = useState(() => sessionStorage.getItem('rp-admin-passcode') ?? '')
  const [draft, setDraft] = useState('')
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
          <div className='mt-8 space-y-6'>
            <Skeleton className='h-56 w-full' />
            <Skeleton className='h-56 w-full' />
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
          <div className='mt-8 space-y-6'>
            <AddPortal passcode={passcode} />
            {data.map((row) => <TenantCard key={row.tenant.slug} row={row} passcode={passcode} />)}
          </div>
        )}

        {data && (
          <div className='mt-6'>
            <MigratePanel rows={data} passcode={passcode} />
          </div>
        )}
      </div>
    </main>
  )
}
