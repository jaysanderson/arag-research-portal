import { type FormEvent, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useOutletContext } from 'react-router-dom'
import type { Labelset } from '@research-portal/core'
import { createAdminLabelset, getFacets, getLabelsets } from '../api/client.ts'
import { ErrorCard, Skeleton } from '../components/ui.tsx'
import { MessagePanel } from './admin/MessagePanel.tsx'
import { errorMessage, inputClass, type Message } from './admin/shared.ts'
import type { TenantOutletContext } from './TenantLayout.tsx'

function LabelsetCard({
  labelset,
  counts,
}: {
  labelset: Labelset
  counts: Record<string, number>
}) {
  const sorted = [...labelset.labels].sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0))

  return (
    <div className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
      <div className='flex items-baseline justify-between gap-3'>
        <h2 className='text-lg font-semibold tracking-tight text-neutral-900'>{labelset.title}</h2>
        <span className='shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-500'>
          {labelset.labels.length} {labelset.labels.length === 1 ? 'value' : 'values'}
        </span>
      </div>
      <p className='mt-1 text-xs text-neutral-500'>
        {labelset.multiple ? 'Multiple values per resource' : 'Single value per resource'}
      </p>

      {sorted.length === 0
        ? <p className='mt-4 text-sm text-neutral-400'>No values yet.</p>
        : (
          <div className='mt-4 flex flex-wrap gap-2'>
            {sorted.map((label) => {
              const count = counts[label] ?? 0
              return (
                <span
                  key={label}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset ${
                    count > 0
                      ? 'bg-neutral-100 text-neutral-800 ring-neutral-200'
                      : 'bg-neutral-50 text-neutral-400 ring-neutral-100'
                  }`}
                >
                  {label}
                  <span className={count > 0 ? 'text-neutral-500' : 'text-neutral-300'}>
                    {count}
                  </span>
                </span>
              )
            })}
          </div>
        )}
    </div>
  )
}

function AddLabelsetCard({
  slug,
  onAdded,
}: {
  slug: string
  onAdded: () => Promise<unknown>
}) {
  const [title, setTitle] = useState('')
  const [multiple, setMultiple] = useState(false)
  const [seed, setSeed] = useState('')
  const [passcode, setPasscode] = useState(
    () => sessionStorage.getItem('rp-admin-passcode') ?? '',
  )
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const labels = seed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    setBusy(true)
    setMessage(null)
    try {
      await createAdminLabelset(slug, passcode, { title: title.trim(), multiple, labels })
      setMessage({ tone: 'ok', text: `Added "${title.trim()}" - it will appear once indexed.` })
      setTitle('')
      setSeed('')
      await onAdded()
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not add that category - please try again.'),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='rounded-2xl border border-dashed border-neutral-300 bg-white/60 p-6'>
      <h2 className='text-sm font-semibold text-neutral-900'>Add a category</h2>
      <form onSubmit={onSubmit} className='mt-4 space-y-3'>
        <div>
          <label
            htmlFor='taxonomy-name'
            className='mb-1.5 block text-sm font-medium text-neutral-900'
          >
            Name
          </label>
          <input
            id='taxonomy-name'
            className={inputClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder='e.g. Region'
            autoComplete='off'
            required
          />
        </div>

        <div>
          <p className='mb-1.5 block text-sm font-medium text-neutral-900'>Values per resource</p>
          <div className='inline-flex rounded-full border border-neutral-200 bg-white p-1'>
            <button
              type='button'
              onClick={() => setMultiple(false)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 ${
                !multiple ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              Single
            </button>
            <button
              type='button'
              onClick={() => setMultiple(true)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 ${
                multiple ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
              }`}
            >
              Multiple
            </button>
          </div>
        </div>

        <div>
          <label
            htmlFor='taxonomy-seed'
            className='mb-1.5 block text-sm font-medium text-neutral-900'
          >
            Seed values
          </label>
          <input
            id='taxonomy-seed'
            className={inputClass}
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder='Comma-separated, e.g. North, South, East, West'
            autoComplete='off'
          />
        </div>

        <div>
          <label
            htmlFor='taxonomy-passcode'
            className='mb-1.5 block text-sm font-medium text-neutral-900'
          >
            Admin passcode
          </label>
          <input
            id='taxonomy-passcode'
            type='password'
            className={inputClass}
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            autoComplete='off'
            required
          />
        </div>

        <button
          type='submit'
          disabled={busy}
          className='inline-flex items-center rounded-full bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800 disabled:opacity-60'
        >
          {busy ? 'Adding…' : 'Add category'}
        </button>
      </form>

      {message && <MessagePanel message={message} className='mt-4' />}
    </div>
  )
}

function LabelsetCardSkeleton() {
  return (
    <div className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm'>
      <Skeleton className='h-5 w-1/3' />
      <Skeleton className='mt-3 h-4 w-1/2' />
      <div className='mt-4 flex flex-wrap gap-2'>
        <Skeleton className='h-6 w-20 rounded-full' />
        <Skeleton className='h-6 w-24 rounded-full' />
        <Skeleton className='h-6 w-16 rounded-full' />
      </div>
    </div>
  )
}

/**
 * Taxonomy - the categories used to classify resources, with live counts
 * from the knowledge box, plus an admin affordance to add a new category.
 */
export function TaxonomyPage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const slug = config.slug
  const queryClient = useQueryClient()

  const {
    data: labelsets,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['labelsets', slug],
    queryFn: () => getLabelsets(slug),
  })

  const labelsetIds = useMemo(() => labelsets?.map((l) => l.id) ?? [], [labelsets])

  const { data: facets } = useQuery({
    queryKey: ['facets', slug, labelsetIds],
    queryFn: () => getFacets(slug, labelsetIds),
    enabled: labelsetIds.length > 0,
  })

  const refreshAll = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['labelsets', slug] }),
      queryClient.invalidateQueries({ queryKey: ['facets', slug] }),
    ])

  return (
    <main className='mx-auto max-w-6xl px-6 py-10'>
      <h1 className='text-2xl font-semibold tracking-tight text-neutral-900'>Taxonomy</h1>
      <p className='mt-1 text-sm text-neutral-500'>
        Categories used to classify resources. Counts reflect indexed content.
      </p>

      {isLoading && (
        <div className='mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2'>
          <LabelsetCardSkeleton />
          <LabelsetCardSkeleton />
        </div>
      )}

      {isError && (
        <div className='mt-8'>
          <ErrorCard
            message={error instanceof Error ? error.message : 'Could not load the taxonomy.'}
            onRetry={() => void refetch()}
          />
        </div>
      )}

      {labelsets && (
        <div className='mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2'>
          {labelsets.map((ls) => (
            <LabelsetCard key={ls.id} labelset={ls} counts={facets?.[ls.id] ?? {}} />
          ))}
          <AddLabelsetCard slug={slug} onAdded={refreshAll} />
        </div>
      )}
    </main>
  )
}
