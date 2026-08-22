import { type ChangeEvent, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { uploadBranding } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

const MAX_BYTES = 5 * 1024 * 1024

type Kind = 'logo' | 'hero'

const CHECKERBOARD_STYLE = {
  backgroundImage: 'repeating-conic-gradient(var(--rp-surface-3) 0% 25%, var(--rp-surface) 0% 50%)',
  backgroundSize: '16px 16px',
}

function brandingUrl(slug: string, kind: Kind, version: number): string {
  return `/api/t/${encodeURIComponent(slug)}/branding/${kind}?v=${version}`
}

/** One upload card: preview, guidance copy and an "Upload…" pill button. */
function UploadCard({
  slug,
  passcode,
  kind,
  title,
  guidance,
  onUploaded,
}: {
  slug: string
  passcode: string
  kind: Kind
  title: string
  guidance: string
  onUploaded: () => Promise<unknown>
}) {
  const [version, setVersion] = useState(0)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const onChoose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (file.size > MAX_BYTES) {
      setMessage({ tone: 'error', text: 'That file is too large - the limit is 5 MB.' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await uploadBranding(slug, passcode, kind, file)
      setVersion((v) => v + 1)
      setMissing(false)
      await onUploaded()
      setMessage({ tone: 'ok', text: 'Uploaded - the portal now uses it.' })
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not upload that image - please try again.'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='rounded-[calc(var(--rp-radius)+4px)] border border-line bg-surface-2 p-4'>
      <h4 className='text-sm font-semibold text-ink'>{title}</h4>
      <p className='mt-1 text-xs text-ink-3'>{guidance}</p>

      <div
        style={CHECKERBOARD_STYLE}
        className={`mt-3 overflow-hidden rounded-[var(--rp-radius)] border border-line ${
          kind === 'logo' ? 'flex h-16 items-center justify-center p-2' : 'aspect-[16/6]'
        }`}
      >
        {missing
          ? (
            <div className='flex h-full w-full items-center justify-center text-xs text-ink-3'>
              None uploaded yet
            </div>
          )
          : (
            <img
              key={version}
              src={brandingUrl(slug, kind, version)}
              alt={`${title} preview`}
              onError={() => setMissing(true)}
              className={kind === 'logo'
                ? 'h-full w-auto object-contain'
                : 'h-full w-full object-cover'}
            />
          )}
      </div>

      <label className='rp-btn rp-btn-primary mt-3 cursor-pointer'>
        {busy ? 'Uploading…' : 'Upload…'}
        <input
          type='file'
          accept='image/png,image/jpeg,image/webp,image/svg+xml'
          className='sr-only'
          disabled={busy}
          onChange={(e) => void onChoose(e)}
        />
      </label>

      {message && <MessagePanel message={message} className='mt-3' />}
    </div>
  )
}

/**
 * Appearance section: upload a logo and a hero image for a tenant's portal.
 * Each upload posts straight to the branding endpoint, then bumps a local
 * cache-busting counter so the preview picks up the new file immediately.
 */
export function AppearancePanel({ slug, passcode }: { slug: string; passcode: string }) {
  const queryClient = useQueryClient()

  const onUploaded = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tenant-config'] }),
      queryClient.invalidateQueries({ queryKey: ['tenants'] }),
    ])

  return (
    <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
      <UploadCard
        slug={slug}
        passcode={passcode}
        kind='logo'
        title='Logo'
        guidance='PNG or SVG with transparency works best - shown in the header at 28px tall.'
        onUploaded={onUploaded}
      />
      <UploadCard
        slug={slug}
        passcode={passcode}
        kind='hero'
        title='Hero image'
        guidance='Wide photographic image, at least 1600px - shown behind the portal hero.'
        onUploaded={onUploaded}
      />
    </div>
  )
}
