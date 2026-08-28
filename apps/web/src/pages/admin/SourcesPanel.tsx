import { type FormEvent, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { PortalSource, SourceSyncEvent } from '../../api/client.ts'
import { addSource, deleteSource, getSources, syncSource } from '../../api/client.ts'
import { Skeleton } from '../../components/ui.tsx'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

/** Same relative-time shape used across the admin panels, applied to ISO timestamps. */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

function SourceRow({
  source,
  slug,
  passcode,
  onChanged,
}: {
  source: PortalSource
  slug: string
  passcode: string
  onChanged: () => Promise<unknown>
}) {
  const [syncing, setSyncing] = useState(false)
  const [log, setLog] = useState<SourceSyncEvent[]>([])
  const [deleting, setDeleting] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const onSync = async () => {
    setSyncing(true)
    setLog([])
    setMessage(null)
    try {
      await syncSource(slug, passcode, source.id, (event) => {
        setLog((prev) => [...prev, event])
        if (event.type === 'done') {
          const deferred = event.deferred ?? 0
          setMessage({
            // Deferring pages under back-pressure is graceful handling, not a
            // failure - the sync still made progress and will finish itself.
            tone: 'ok',
            text: deferred > 0
              ? `Synced - ${event.added} ${event.added === 1 ? 'page' : 'pages'} added. ` +
                `The knowledge box was busy, so ${deferred} ${
                  deferred === 1 ? 'page was' : 'pages were'
                } left for the next sync.`
              : `Synced - ${event.added} ${event.added === 1 ? 'page' : 'pages'} added.`,
          })
        }
        if (event.type === 'error') setMessage({ tone: 'error', text: event.message })
      })
      await onChanged()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Sync failed - please retry.') })
    } finally {
      setSyncing(false)
    }
  }

  const onDelete = async () => {
    setDeleting(true)
    setMessage(null)
    try {
      await deleteSource(slug, passcode, source.id)
      await onChanged()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not remove that source.') })
      setDeleting(false)
    }
  }

  return (
    <li className='bg-surface px-4 py-3'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='min-w-0'>
          <p className='truncate text-sm font-medium text-ink'>{source.url}</p>
          <p className='mt-0.5 text-xs text-ink-3'>
            {source.lastSync
              ? `Last synced ${relativeTime(source.lastSync)} - ${source.lastAdded} ${
                source.lastAdded === 1 ? 'page' : 'pages'
              } added`
              : 'Never synced'}
            {source.auto && <span className='rp-badge rp-badge-quiet ml-2'>Auto</span>}
          </p>
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          <button
            type='button'
            disabled={syncing}
            onClick={() => void onSync()}
            className='rp-btn rp-btn-outline'
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          <button
            type='button'
            disabled={deleting || syncing}
            onClick={() => void onDelete()}
            className='rp-btn rp-btn-ghost'
            style={{ color: 'var(--rp-bad-ink)' }}
          >
            {deleting ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>

      {log.length > 0 && (
        <ol className='mt-3 max-h-40 space-y-1 overflow-y-auto rounded-[var(--rp-radius)] border border-line bg-surface-2 p-3 text-xs'>
          {log.map((event, index) => (
            <li key={index}>
              {event.type === 'item' && <span className='text-ink-2'>{event.label}</span>}
              {event.type === 'done' && (
                <span className='font-medium' style={{ color: 'var(--rp-ok-ink)' }}>
                  Finished - {event.added} added.
                </span>
              )}
              {event.type === 'error' && (
                <span style={{ color: 'var(--rp-bad-ink)' }}>{event.message}</span>
              )}
            </li>
          ))}
        </ol>
      )}

      {message && <MessagePanel message={message} className='mt-3' />}
    </li>
  )
}

/**
 * Living sources: website/sitemap URLs the librarian registers once, then the
 * platform re-checks daily and ingests new pages automatically. Distinct from
 * the one-off "Add content" ingestion methods.
 */
export function SourcesPanel({ slug, passcode }: { slug: string; passcode: string }) {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['admin-sources', slug],
    queryFn: () => getSources(slug, passcode),
  })

  const onChanged = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['admin-sources', slug] }),
      queryClient.invalidateQueries({ queryKey: ['admin-recent', slug] }),
    ])

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setAdding(true)
    setMessage(null)
    try {
      await addSource(slug, passcode, url)
      setUrl('')
      setMessage({ tone: 'ok', text: 'Source added - it will be checked on the daily schedule.' })
      await onChanged()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not add that source.') })
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-4'>
      <div>
        <p className='text-sm font-semibold text-ink'>Sources</p>
        <p className='mt-0.5 text-xs text-ink-3'>
          Register a website or sitemap once. Sources are re-checked daily and new pages are
          ingested automatically.
        </p>
      </div>

      <form onSubmit={onSubmit} className='mt-3 flex flex-wrap items-end gap-2'>
        <div className='min-w-0 flex-1'>
          <label
            htmlFor={`source-url-${slug}`}
            className='mb-1.5 block text-sm font-medium text-ink'
          >
            Site or sitemap URL
          </label>
          <input
            id={`source-url-${slug}`}
            type='url'
            className='rp-input'
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder='https://example.com/sitemap.xml'
            autoComplete='off'
            required
          />
        </div>
        <button type='submit' disabled={adding} className='rp-btn rp-btn-primary'>
          {adding ? 'Adding…' : 'Add source'}
        </button>
      </form>

      {message && <MessagePanel message={message} className='mt-3' />}

      <div className='mt-4 border-t border-line pt-3'>
        {isLoading && (
          <div className='space-y-2'>
            <Skeleton className='h-12 w-full' />
            <Skeleton className='h-12 w-full' />
          </div>
        )}

        {isError && (
          <p className='text-sm text-ink-3'>
            Could not load sources.{' '}
            <button
              type='button'
              onClick={() => void refetch()}
              className='font-medium text-ink-2 hover:text-[var(--rp-ink)]'
            >
              Try again
            </button>
          </p>
        )}

        {data && data.length === 0 && (
          <p className='text-sm text-ink-3'>No sources registered yet.</p>
        )}

        {data && data.length > 0 && (
          <ul className='divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
            {data.map((source) => (
              <SourceRow
                key={source.id}
                source={source}
                slug={slug}
                passcode={passcode}
                onChanged={onChanged}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
