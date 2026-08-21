import { type ChangeEvent, type DragEvent, type FormEvent, useState } from 'react'
import { addAdminLink, addAdminText, uploadAdminFile } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, inputClass, type Message } from './shared.ts'

type Tab = 'upload' | 'link' | 'text'

const TABS: { id: Tab; label: string }[] = [
  { id: 'upload', label: 'Upload file' },
  { id: 'link', label: 'Add link' },
  { id: 'text', label: 'Paste text' },
]

/**
 * Collapsible "Add content" panel with three ways to add a resource to a
 * tenant's knowledge box: upload a file, add a link, or paste text. Closed
 * by default so a stats-only glance at the card stays uncluttered.
 */
export function AddContent({
  slug,
  passcode,
  onAdded,
}: {
  slug: string
  passcode: string
  onAdded: () => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('upload')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const [url, setUrl] = useState('')
  const [linkTitle, setLinkTitle] = useState('')
  const [textTitle, setTextTitle] = useState('')
  const [textBody, setTextBody] = useState('')

  const run = async (
    action: () => Promise<{ id: string }>,
    successText: string,
  ): Promise<boolean> => {
    setBusy(true)
    setMessage(null)
    try {
      await action()
      setMessage({ tone: 'ok', text: successText })
      await onAdded()
      return true
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not add that content - please try again.'),
      })
      return false
    } finally {
      setBusy(false)
    }
  }

  const onChooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    void run(
      () => uploadAdminFile(slug, passcode, file),
      `Uploaded "${file.name}" - it will appear below once processed.`,
    )
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragOver(false)
    const file = event.dataTransfer.files[0]
    if (!file) return
    void run(
      () => uploadAdminFile(slug, passcode, file),
      `Uploaded "${file.name}" - it will appear below once processed.`,
    )
  }

  const onSubmitLink = async (event: FormEvent) => {
    event.preventDefault()
    const ok = await run(
      () => addAdminLink(slug, passcode, { url, title: linkTitle.trim() || undefined }),
      'Link added - it will appear below once processed.',
    )
    if (ok) {
      setUrl('')
      setLinkTitle('')
    }
  }

  const onSubmitText = async (event: FormEvent) => {
    event.preventDefault()
    const ok = await run(
      () => addAdminText(slug, passcode, { title: textTitle, body: textBody }),
      'Text added - it will appear below once processed.',
    )
    if (ok) {
      setTextTitle('')
      setTextBody('')
    }
  }

  return (
    <div className='mt-5'>
      <button
        type='button'
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className='inline-flex items-center gap-1.5 text-sm font-medium text-neutral-700 transition-colors duration-150 hover:text-neutral-900'
      >
        <span aria-hidden='true'>{open ? '▾' : '▸'}</span>
        Add content
      </button>

      {open && (
        <div className='mt-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4'>
          <div className='inline-flex rounded-full border border-neutral-200 bg-white p-1'>
            {TABS.map((t) => (
              <button
                key={t.id}
                type='button'
                onClick={() => {
                  setTab(t.id)
                  setMessage(null)
                }}
                className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 ${
                  tab === t.id
                    ? 'bg-neutral-900 text-white'
                    : 'text-neutral-600 hover:bg-neutral-100'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className='mt-4'>
            {tab === 'upload' && (
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={onDrop}
                className={`rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors duration-150 ${
                  dragOver ? 'border-neutral-400 bg-neutral-100' : 'border-neutral-300'
                }`}
              >
                <p className='text-sm text-neutral-600'>
                  Drag a file here, or choose one to upload.
                </p>
                <label className='mt-3 inline-flex cursor-pointer items-center rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800'>
                  {busy ? 'Uploading…' : 'Choose file'}
                  <input type='file' className='sr-only' disabled={busy} onChange={onChooseFile} />
                </label>
                <p className='mt-2 text-xs text-neutral-500'>Up to 100 MB.</p>
              </div>
            )}

            {tab === 'link' && (
              <form onSubmit={onSubmitLink} className='space-y-3'>
                <div>
                  <label
                    htmlFor={`link-url-${slug}`}
                    className='mb-1.5 block text-sm font-medium text-neutral-900'
                  >
                    URL
                  </label>
                  <input
                    id={`link-url-${slug}`}
                    type='url'
                    className={inputClass}
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder='https://example.com/report'
                    autoComplete='off'
                    required
                  />
                </div>
                <div>
                  <label
                    htmlFor={`link-title-${slug}`}
                    className='mb-1.5 block text-sm font-medium text-neutral-900'
                  >
                    Title (optional)
                  </label>
                  <input
                    id={`link-title-${slug}`}
                    className={inputClass}
                    value={linkTitle}
                    onChange={(e) => setLinkTitle(e.target.value)}
                    placeholder='Leave blank to use the page title'
                    autoComplete='off'
                  />
                </div>
                <button
                  type='submit'
                  disabled={busy}
                  className='inline-flex items-center rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800 disabled:opacity-60'
                >
                  {busy ? 'Adding…' : 'Add link'}
                </button>
              </form>
            )}

            {tab === 'text' && (
              <form onSubmit={onSubmitText} className='space-y-3'>
                <div>
                  <label
                    htmlFor={`text-title-${slug}`}
                    className='mb-1.5 block text-sm font-medium text-neutral-900'
                  >
                    Title
                  </label>
                  <input
                    id={`text-title-${slug}`}
                    className={inputClass}
                    value={textTitle}
                    onChange={(e) => setTextTitle(e.target.value)}
                    autoComplete='off'
                    required
                  />
                </div>
                <div>
                  <label
                    htmlFor={`text-body-${slug}`}
                    className='mb-1.5 block text-sm font-medium text-neutral-900'
                  >
                    Text
                  </label>
                  <textarea
                    id={`text-body-${slug}`}
                    className={inputClass}
                    rows={6}
                    value={textBody}
                    onChange={(e) => setTextBody(e.target.value)}
                    required
                  />
                </div>
                <button
                  type='submit'
                  disabled={busy}
                  className='inline-flex items-center rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800 disabled:opacity-60'
                >
                  {busy ? 'Adding…' : 'Add text'}
                </button>
              </form>
            )}
          </div>

          {message && <MessagePanel message={message} className='mt-4' />}
        </div>
      )}
    </div>
  )
}
