import { type ChangeEvent, type DragEvent, type FormEvent, useState } from 'react'
import { addAdminLink, addAdminText, discoverCrawl, uploadAdminFile } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, inputClass, type Message } from './shared.ts'

type Tab = 'upload' | 'link' | 'text' | 'crawl'

const TABS: { id: Tab; label: string }[] = [
  { id: 'upload', label: 'Upload file' },
  { id: 'link', label: 'Add link' },
  { id: 'text', label: 'Paste text' },
  { id: 'crawl', label: 'Crawl site' },
]

const CRAWL_LIMITS = [25, 50, 100] as const

/**
 * Discover links on a site and ingest a chosen subset. Two steps: discover
 * (list candidate URLs) then ingest (add each selected link sequentially,
 * reusing the same admin endpoint as the "Add link" tab).
 */
function CrawlTab({
  slug,
  passcode,
  onAdded,
}: {
  slug: string
  passcode: string
  onAdded: () => Promise<unknown>
}) {
  const [url, setUrl] = useState('')
  const [limit, setLimit] = useState<(typeof CRAWL_LIMITS)[number]>(50)
  const [discovering, setDiscovering] = useState(false)
  const [links, setLinks] = useState<string[] | null>(null)
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [ingesting, setIngesting] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [message, setMessage] = useState<Message | null>(null)

  const selectedLinks = links?.filter((link) => checked[link]) ?? []

  const onDiscover = async (event: FormEvent) => {
    event.preventDefault()
    setDiscovering(true)
    setMessage(null)
    setLinks(null)
    setProgress(null)
    try {
      const result = await discoverCrawl(slug, passcode, url, limit)
      setLinks(result.links)
      setChecked(Object.fromEntries(result.links.map((link) => [link, true])))
      if (result.links.length === 0) {
        setMessage({ tone: 'error', text: 'No links were found at that address.' })
      }
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not crawl that site - please try again.'),
      })
    } finally {
      setDiscovering(false)
    }
  }

  const toggleAll = (value: boolean) => {
    if (!links) return
    setChecked(Object.fromEntries(links.map((link) => [link, value])))
  }

  const onIngest = async () => {
    if (selectedLinks.length === 0) return
    setIngesting(true)
    setMessage(null)
    setProgress({ done: 0, total: selectedLinks.length })
    let failures = 0
    for (const [index, link] of selectedLinks.entries()) {
      try {
        await addAdminLink(slug, passcode, { url: link })
      } catch {
        failures += 1
      }
      setProgress({ done: index + 1, total: selectedLinks.length })
    }
    setIngesting(false)
    setMessage(
      failures === 0
        ? {
          tone: 'ok',
          text: `Added ${selectedLinks.length} ${
            selectedLinks.length === 1 ? 'link' : 'links'
          } - they will appear below once processed.`,
        }
        : {
          tone: 'error',
          text: `Added ${
            selectedLinks.length - failures
          } of ${selectedLinks.length} links - ${failures} failed.`,
        },
    )
    setLinks(null)
    setChecked({})
    await onAdded()
  }

  return (
    <div className='space-y-4'>
      <form onSubmit={onDiscover} className='space-y-3'>
        <div>
          <label
            htmlFor={`crawl-url-${slug}`}
            className='mb-1.5 block text-sm font-medium text-neutral-900'
          >
            Site URL
          </label>
          <input
            id={`crawl-url-${slug}`}
            type='url'
            className={inputClass}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder='https://example.com'
            autoComplete='off'
            required
          />
        </div>
        <div>
          <label
            htmlFor={`crawl-limit-${slug}`}
            className='mb-1.5 block text-sm font-medium text-neutral-900'
          >
            Link limit
          </label>
          <select
            id={`crawl-limit-${slug}`}
            className={inputClass}
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value) as (typeof CRAWL_LIMITS)[number])}
          >
            {CRAWL_LIMITS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <button
          type='submit'
          disabled={discovering}
          className='inline-flex items-center rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800 disabled:opacity-60'
        >
          {discovering ? 'Discovering…' : 'Discover'}
        </button>
      </form>

      {links && links.length > 0 && (
        <div className='rounded-xl border border-neutral-200 bg-white p-4'>
          <div className='flex items-center justify-between gap-3'>
            <p className='text-sm font-medium text-neutral-900'>
              {links.length} {links.length === 1 ? 'link' : 'links'} found
            </p>
            <div className='flex items-center gap-3 text-sm font-medium text-neutral-600'>
              <button
                type='button'
                onClick={() => toggleAll(true)}
                className='transition-colors duration-150 hover:text-neutral-900'
              >
                Select all
              </button>
              <button
                type='button'
                onClick={() => toggleAll(false)}
                className='transition-colors duration-150 hover:text-neutral-900'
              >
                Select none
              </button>
            </div>
          </div>

          <ul className='mt-3 max-h-64 space-y-1.5 overflow-y-auto'>
            {links.map((link) => (
              <li key={link}>
                <label className='flex items-start gap-2 text-sm text-neutral-700'>
                  <input
                    type='checkbox'
                    className='mt-0.5'
                    checked={checked[link] ?? false}
                    onChange={(e) => setChecked((prev) => ({ ...prev, [link]: e.target.checked }))}
                  />
                  <span className='break-all'>{link}</span>
                </label>
              </li>
            ))}
          </ul>

          <button
            type='button'
            onClick={() => void onIngest()}
            disabled={ingesting || selectedLinks.length === 0}
            className='mt-4 inline-flex items-center rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800 disabled:opacity-60'
          >
            {ingesting
              ? `Ingesting ${progress?.done ?? 0} of ${progress?.total ?? selectedLinks.length}…`
              : `Ingest ${selectedLinks.length} selected`}
          </button>
        </div>
      )}

      {message && <MessagePanel message={message} />}
    </div>
  )
}

/**
 * Collapsible "Add content" panel with four ways to add a resource to a
 * tenant's knowledge box: upload a file, add a link, paste text, or discover
 * and ingest links from a crawled site. Closed by default so a stats-only
 * glance at the card stays uncluttered.
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

            {tab === 'crawl' && <CrawlTab slug={slug} passcode={passcode} onAdded={onAdded} />}
          </div>

          {tab !== 'crawl' && message && <MessagePanel message={message} className='mt-4' />}
        </div>
      )}
    </div>
  )
}
