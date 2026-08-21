import { type FormEvent, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { addPortal } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, inputClass, type Message } from './shared.ts'

/**
 * Add a brand-new knowledge box portal: names the portal, then its card
 * appears below where you create a fresh box on the platform or connect an
 * existing endpoint.
 */
export function AddPortal({ passcode }: { passcode: string }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [organisation, setOrganisation] = useState('')
  const [tagline, setTagline] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const result = await addPortal(passcode, {
        name,
        organisation: organisation || undefined,
        tagline: tagline || undefined,
      })
      setName('')
      setOrganisation('')
      setTagline('')
      setMessage({
        tone: 'ok',
        text:
          `Portal '${result.slug}' added - use its card below to create a fresh knowledge box ` +
          'on the platform or connect an existing endpoint.',
      })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['admin-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['tenants'] }),
      ])
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not add the portal.') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className='rounded-2xl border border-dashed border-neutral-300 bg-white p-6 shadow-sm'>
      <h2 className='text-lg font-semibold tracking-tight text-neutral-900'>
        Add a knowledge box
      </h2>
      <p className='mt-1 text-sm text-neutral-500'>
        Creates a new portal. You then either deploy a fresh knowledge box on the platform or
        connect an existing one from its card.
      </p>
      <form onSubmit={onSubmit} className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3'>
        <div>
          <label
            htmlFor='portal-name'
            className='mb-1.5 block text-sm font-medium text-neutral-900'
          >
            Name
          </label>
          <input
            id='portal-name'
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='e.g. AgriFutures Research Hub'
            autoComplete='off'
            required
            minLength={2}
          />
        </div>
        <div>
          <label
            htmlFor='portal-org'
            className='mb-1.5 block text-sm font-medium text-neutral-900'
          >
            Organisation <span className='font-normal text-neutral-400'>(optional)</span>
          </label>
          <input
            id='portal-org'
            className={inputClass}
            value={organisation}
            onChange={(e) => setOrganisation(e.target.value)}
            autoComplete='off'
          />
        </div>
        <div>
          <label
            htmlFor='portal-tagline'
            className='mb-1.5 block text-sm font-medium text-neutral-900'
          >
            Tagline <span className='font-normal text-neutral-400'>(optional)</span>
          </label>
          <input
            id='portal-tagline'
            className={inputClass}
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
            autoComplete='off'
          />
        </div>
        <div className='sm:col-span-3'>
          <button
            type='submit'
            disabled={busy}
            className='inline-flex items-center rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800 disabled:opacity-60'
          >
            {busy ? 'Adding…' : 'Add portal'}
          </button>
        </div>
      </form>
      {message && <MessagePanel message={message} />}
    </section>
  )
}
