import { type FormEvent, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useOutletContext } from 'react-router-dom'
import {
  ApiError,
  connectKnowledgeBox,
  type ConnectResult,
  getKnowledgeBoxStatus,
} from '../api/client.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'

const inputClass =
  'w-full rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1'

/**
 * Administrator flow: connect this portal to a knowledge box. The KB id and
 * service-account token are entered by the administrator and sent straight to
 * the server, which verifies them against the live platform before saving.
 */
export function ConnectPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const queryClient = useQueryClient()
  const { data: status } = useQuery({
    queryKey: ['kb-status', config.slug],
    queryFn: () => getKnowledgeBoxStatus(config.slug),
  })

  const [kbId, setKbId] = useState('')
  const [token, setToken] = useState('')
  const [passcode, setPasscode] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ConnectResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setErrorMessage(null)
    setResult(null)
    try {
      const outcome = await connectKnowledgeBox(config.slug, { kbId, token, passcode })
      setResult(outcome)
      setKbId('')
      setToken('')
      await queryClient.invalidateQueries()
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError && err.status === 401
          ? 'That admin passcode was not accepted.'
          : err instanceof Error
          ? err.message
          : 'Connection failed - please try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className='mx-auto max-w-2xl px-6 py-12'>
      <Link
        to={`/t/${config.slug}`}
        className='text-sm text-neutral-500 transition-colors duration-150 hover:text-neutral-900'
      >
        &larr; Back to explore
      </Link>
      <h1 className='mt-4 text-2xl font-semibold tracking-tight text-neutral-900'>
        Connect a knowledge box
      </h1>
      <p className='mt-2 text-sm leading-6 text-neutral-600'>
        Wire {config.branding.productName}{' '}
        to a Progress Agentic RAG knowledge box. The connection is verified against the live
        platform before it is saved, and replaces the current source for every answer, search and
        topic row.
      </p>

      {status && (
        <div
          className={`mt-6 flex items-center gap-3 rounded-xl border px-4 py-3 text-sm ${
            status.status === 'connected'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : status.status === 'demo'
              ? 'border-amber-200 bg-amber-50 text-amber-800'
              : 'border-neutral-200 bg-white text-neutral-600'
          }`}
        >
          {status.status === 'connected' && (
            <span>
              Connected to knowledge box <span className='font-mono'>{status.kbId}</span>
            </span>
          )}
          {status.status === 'demo' && (
            <span>
              Currently using the <strong>demo only</strong> knowledge box{' '}
              <span className='font-mono'>{status.kbId}</span> - connect the real one below.
            </span>
          )}
          {status.status === 'none' && <span>No knowledge box is connected yet.</span>}
        </div>
      )}

      <form onSubmit={onSubmit} className='mt-8 space-y-5'>
        <div>
          <label htmlFor='kb-id' className='mb-1.5 block text-sm font-medium text-neutral-900'>
            Knowledge box ID
          </label>
          <input
            id='kb-id'
            className={inputClass}
            style={{ outlineColor: 'var(--rp-accent)' }}
            value={kbId}
            onChange={(e) => setKbId(e.target.value)}
            placeholder='e.g. 1dd4e0c0-e3c8-413d-9241-e8d6fd951a97'
            autoComplete='off'
            required
          />
        </div>
        <div>
          <label htmlFor='kb-token' className='mb-1.5 block text-sm font-medium text-neutral-900'>
            Service-account token
          </label>
          <input
            id='kb-token'
            type='password'
            className={inputClass}
            style={{ outlineColor: 'var(--rp-accent)' }}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder='Paste the KB service-account token'
            autoComplete='off'
            required
          />
          <p className='mt-1.5 text-xs text-neutral-500'>
            Stored server-side only - it never appears in the browser again after you connect.
          </p>
        </div>
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
            style={{ outlineColor: 'var(--rp-accent)' }}
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            autoComplete='off'
            required
          />
        </div>
        <button
          type='submit'
          disabled={busy}
          className='inline-flex items-center rounded-full px-5 py-2.5 text-sm font-medium text-white transition-opacity duration-150 disabled:opacity-60'
          style={{ backgroundColor: 'var(--rp-primary)' }}
        >
          {busy ? 'Verifying connection…' : 'Verify and connect'}
        </button>
      </form>

      {result && (
        <div
          role='status'
          className='mt-6 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800'
        >
          Connected. The knowledge box responded with {result.resourceCount}{' '}
          {result.resourceCount === 1 ? 'resource' : 'resources'}{' '}
          - the portal is now serving from it.
        </div>
      )}
      {errorMessage && (
        <div
          role='alert'
          className='mt-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800'
        >
          {errorMessage}
        </div>
      )}
    </main>
  )
}
