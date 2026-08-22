import { type FormEvent, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { AdminTenantOverview } from '@research-portal/core'
import {
  connectKnowledgeBox,
  removePortal,
  revertKnowledgeBox,
  setPortalDisabled,
} from '../../api/client.ts'
import { AddContent } from './AddContent.tsx'
import { AnalysePanel } from './AnalysePanel.tsx'
import { AppearancePanel } from './AppearancePanel.tsx'
import { CreateKbBox } from './CreateKbBox.tsx'
import { KgPanel } from './KgPanel.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { RecentList } from './RecentList.tsx'
import { RenamePortal } from './RenamePortal.tsx'
import { Section } from './Section.tsx'
import { errorMessage, inputClass, type Message } from './shared.ts'
import { StatTiles } from './StatTiles.tsx'

type Status = AdminTenantOverview['knowledgeBox']['status']

const STATUS_DOT: Record<Status, string> = {
  connected: 'bg-emerald-500',
  demo: 'bg-amber-500',
  none: 'bg-neutral-300',
}

function StatusDot({ status }: { status: Status }) {
  return (
    <span
      aria-hidden='true'
      className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[status]}`}
    />
  )
}

function StatusBadge({ status }: { status: Status }) {
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

/**
 * One portal in the admin accordion. Collapsed by default to a single
 * summary row; the caller controls expansion so only one portal is open at
 * a time. Expanded content is reorganised into small sub-sections that are
 * themselves closed by default, except Connection.
 */
export function PortalRow({
  row,
  passcode,
  expanded,
  onToggleExpanded,
}: {
  row: AdminTenantOverview
  passcode: string
  expanded: boolean
  onToggleExpanded: () => void
}) {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [intelligenceOpen, setIntelligenceOpen] = useState(false)

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
        text: errorMessage(err, 'Could not revert - please try again.'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className='overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm'>
      <button
        type='button'
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        className='flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 px-6 py-4 text-left transition-colors duration-150 hover:bg-neutral-50'
      >
        <span className='flex min-w-0 flex-1 items-center gap-3'>
          <StatusDot status={row.knowledgeBox.status} />
          <span className='min-w-0 truncate'>
            <span className='font-semibold text-neutral-900'>{row.tenant.productName}</span>
            <span className='ml-2 text-sm text-neutral-500'>{row.tenant.organisation}</span>
          </span>
        </span>
        <span className='flex shrink-0 items-center gap-2'>
          <StatusBadge status={row.knowledgeBox.status} />
          {row.disabled && (
            <span className='rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500'>
              Hidden
            </span>
          )}
        </span>
        <span className='shrink-0 text-sm text-neutral-500'>
          {row.resourceCount === null
            ? 'unreachable'
            : `${row.resourceCount} ${row.resourceCount === 1 ? 'document' : 'documents'}`}
        </span>
        <span
          aria-hidden='true'
          className={`shrink-0 text-neutral-400 transition-transform duration-150 ${
            expanded ? 'rotate-180' : ''
          }`}
        >
          ▾
        </span>
      </button>

      {expanded && (
        <div className='border-t border-neutral-100'>
          <div className='flex flex-wrap items-start justify-between gap-4 px-6 py-5'>
            {renaming
              ? (
                <RenamePortal
                  slug={row.tenant.slug}
                  passcode={passcode}
                  initialName={row.tenant.productName}
                  initialOrganisation={row.tenant.organisation}
                  initialTagline={row.tenant.tagline}
                  onCancel={() => setRenaming(false)}
                  onSaved={() => setRenaming(false)}
                />
              )
              : (
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <h3 className='truncate text-lg font-semibold tracking-tight text-neutral-900'>
                      {row.tenant.productName}
                    </h3>
                    <button
                      type='button'
                      onClick={() => setRenaming(true)}
                      className='text-xs font-medium text-neutral-400 transition-colors duration-150 hover:text-neutral-900'
                    >
                      Rename
                    </button>
                  </div>
                  <p className='mt-0.5 text-sm text-neutral-500'>{row.tenant.organisation}</p>
                </div>
              )}

            <div className='flex shrink-0 items-center gap-3'>
              <StatusBadge status={row.knowledgeBox.status} />
              <Link
                to={`/t/${row.tenant.slug}`}
                className='text-sm font-medium text-neutral-500 transition-colors duration-150 hover:text-neutral-900'
              >
                Open portal &rarr;
              </Link>
            </div>
          </div>

          <div className='px-6 pb-5'>
            <Section title='Connection' defaultOpen>
              <dl className='grid grid-cols-1 gap-3 text-sm sm:grid-cols-2'>
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

              <CreateKbBox row={row} passcode={passcode} onCreated={refresh} />

              <form onSubmit={onConnect} className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2'>
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
                <div className='flex flex-wrap items-center gap-3 sm:col-span-2'>
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
                      onClick={() => void onRevert()}
                      className='inline-flex items-center rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-medium text-neutral-700 transition-colors duration-150 hover:bg-neutral-100 disabled:opacity-60'
                    >
                      Revert to demo box
                    </button>
                  )}
                </div>
              </form>
              <p className='mt-2 text-xs text-neutral-500'>
                The connection is verified against the live platform before it is saved. Tokens are
                stored server-side only.
              </p>

              <div className='mt-4 flex flex-wrap items-center gap-4 border-t border-neutral-100 pt-3'>
                <button
                  type='button'
                  disabled={busy}
                  onClick={() => void onToggleDisabled()}
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
                    onClick={() => void onRemove()}
                    className='text-sm font-medium text-rose-500 transition-colors duration-150 hover:text-rose-700 disabled:opacity-60'
                    title='Removes this portal from the app - the knowledge box itself is untouched'
                  >
                    Remove
                  </button>
                )}
              </div>

              {message && <MessagePanel message={message} className='mt-4' />}
            </Section>

            <Section title='Stats'>
              {reachable
                ? (
                  <StatTiles
                    slug={row.tenant.slug}
                    passcode={passcode}
                    resourceCount={row.resourceCount ?? 0}
                  />
                )
                : <p className='text-sm text-neutral-500'>Connect a knowledge box to see stats.</p>}
            </Section>

            <Section title='Content'>
              {reachable
                ? (
                  <>
                    <AddContent
                      slug={row.tenant.slug}
                      passcode={passcode}
                      onAdded={onContentAdded}
                    />
                    <RecentList slug={row.tenant.slug} passcode={passcode} />
                  </>
                )
                : (
                  <p className='text-sm text-neutral-500'>
                    Connect a knowledge box to add content.
                  </p>
                )}
            </Section>

            <Section title='Appearance'>
              <AppearancePanel slug={row.tenant.slug} passcode={passcode} />
            </Section>

            <Section title='Intelligence' open={intelligenceOpen} onToggle={setIntelligenceOpen}>
              {reachable
                ? (
                  <>
                    <AnalysePanel slug={row.tenant.slug} passcode={passcode} />
                    <KgPanel slug={row.tenant.slug} passcode={passcode} open={intelligenceOpen} />
                  </>
                )
                : (
                  <p className='text-sm text-neutral-500'>
                    Connect a knowledge box to run analysis.
                  </p>
                )}
            </Section>
          </div>
        </div>
      )}
    </section>
  )
}
