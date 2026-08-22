import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AdminTenantOverview, MigrationEvent } from '@research-portal/core'
import { migrateKb } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, inputClass, type Message } from './shared.ts'

type ItemEvent = Extract<MigrationEvent, { type: 'item' }>
type DoneEvent = Extract<MigrationEvent, { type: 'done' }>

const OUTCOME_LABEL: Record<ItemEvent['outcome'], string> = {
  copied: 'Copied',
  'skipped-exists': 'Skipped',
  'skipped-unsupported': 'Skipped',
  error: 'Error',
}

const OUTCOME_STYLE: Record<ItemEvent['outcome'], string> = {
  copied: 'bg-emerald-50 text-emerald-800',
  'skipped-exists': 'bg-amber-50 text-amber-800',
  'skipped-unsupported': 'bg-amber-50 text-amber-800',
  error: 'bg-rose-50 text-rose-800',
}

/**
 * Copies every resource from one portal's knowledge box into another's,
 * streaming live progress from the server as it goes. Sits at the bottom of
 * the admin page, its own card, independent of any single tenant.
 */
export function MigratePanel(
  { rows, passcode }: { rows: AdminTenantOverview[]; passcode: string },
) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [running, setRunning] = useState(false)
  const [total, setTotal] = useState<number | null>(null)
  const [items, setItems] = useState<ItemEvent[]>([])
  const [summary, setSummary] = useState<DoneEvent | null>(null)
  const [message, setMessage] = useState<Message | null>(null)

  const options = rows.map((r) => ({ slug: r.tenant.slug, label: r.tenant.productName }))
  const canRun = from.length > 0 && to.length > 0 && from !== to && !running

  const onRun = async () => {
    setRunning(true)
    setMessage(null)
    setTotal(null)
    setItems([])
    setSummary(null)
    try {
      await migrateKb(from, to, passcode, (event) => {
        if (event.type === 'start') setTotal(event.total)
        else if (event.type === 'item') setItems((prev) => [...prev, event])
        else if (event.type === 'done') setSummary(event)
        else if (event.type === 'error') setMessage({ tone: 'error', text: event.message })
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-recent'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-counters'] }),
      ])
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Migration failed - please try again.') })
    } finally {
      setRunning(false)
    }
  }

  return (
    <section className='overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm'>
      <button
        type='button'
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className='flex w-full items-center justify-between gap-3 px-6 py-4 text-left'
      >
        <span className='flex items-center gap-2'>
          <span aria-hidden='true' className='text-neutral-400'>{open ? '▾' : '▸'}</span>
          <span className='text-sm font-semibold text-neutral-900'>Migrate resources</span>
        </span>
        {!open && (
          <span className='hidden text-xs text-neutral-500 sm:inline'>
            Copy resources between portals
          </span>
        )}
      </button>

      {open && (
        <div className='border-t border-neutral-100 px-6 py-5'>
          <p className='text-sm text-neutral-500'>
            Copy every resource from one portal's knowledge box into another's.
          </p>

          <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2'>
            <div>
              <label
                htmlFor='migrate-from'
                className='mb-1.5 block text-sm font-medium text-neutral-900'
              >
                From portal
              </label>
              <select
                id='migrate-from'
                className={inputClass}
                value={from}
                disabled={running}
                onChange={(e) => setFrom(e.target.value)}
              >
                <option value=''>Choose a portal</option>
                {options.map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor='migrate-to'
                className='mb-1.5 block text-sm font-medium text-neutral-900'
              >
                To portal
              </label>
              <select
                id='migrate-to'
                className={inputClass}
                value={to}
                disabled={running}
                onChange={(e) => setTo(e.target.value)}
              >
                <option value=''>Choose a portal</option>
                {options.filter((o) => o.slug !== from).map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            type='button'
            disabled={!canRun}
            onClick={() => void onRun()}
            className='mt-4 inline-flex items-center rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800 disabled:opacity-60'
          >
            {running ? 'Migrating…' : 'Run migration'}
          </button>

          {total !== null && (
            <div className='mt-5'>
              <p className='text-sm text-neutral-600'>
                {items.length} of {total} processed
              </p>
              <ul className='mt-2 max-h-64 space-y-1 overflow-y-auto rounded-xl border border-neutral-200 bg-neutral-50 p-3'>
                {items.map((item) => (
                  <li key={item.id} className='flex items-center justify-between gap-3 text-sm'>
                    <span className='truncate text-neutral-800'>{item.title}</span>
                    <span
                      title={item.detail}
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                        OUTCOME_STYLE[item.outcome]
                      }`}
                    >
                      {OUTCOME_LABEL[item.outcome]}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary && (
            <p className='mt-3 text-sm text-neutral-700'>
              Copied {summary.copied}, skipped {summary.skipped}, {summary.errors} errors.
            </p>
          )}

          {message && <MessagePanel message={message} className='mt-4' />}
        </div>
      )}
    </section>
  )
}
