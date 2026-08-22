import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { TenantSummary } from '@research-portal/core'
import { type EstateEvent, getTenants, streamEstateAsk } from '../api/client.ts'
import { EmptyState, ErrorCard, Skeleton } from '../components/ui.tsx'
import { ThemeToggle } from '../components/ThemeToggle.tsx'
import { TrustSignals } from '../components/QualityGauge.tsx'

/** One portal's progress through the estate-wide ask, keyed by tenant slug. */
interface PortalAskState {
  text: string
  groundedness: number | null
  error: string | null
  done: boolean
}

function emptyPortalState(): PortalAskState {
  return { text: '', groundedness: null, error: null, done: false }
}

/** One result card in the federated-ask panel - a single portal's answer as it streams in. */
function EstatePortalCard({
  slug,
  tenant,
  state,
  query,
}: {
  slug: string
  tenant: TenantSummary | undefined
  state: PortalAskState
  query: string
}) {
  const name = tenant?.productName ?? slug
  const thinking = !state.error && state.text.length === 0 && !state.done

  return (
    <div className='rp-card rp-anim-rise flex flex-col gap-3 p-4 sm:p-5'>
      <div className='flex items-start justify-between gap-2'>
        <div className='min-w-0'>
          <h3 className='truncate text-sm font-semibold tracking-[-0.01em] text-ink'>{name}</h3>
          {tenant?.organisation
            ? <p className='rp-eyebrow mt-0.5 truncate text-ink-3'>{tenant.organisation}</p>
            : null}
        </div>
        {state.error
          ? <span className='rp-badge rp-badge-bad shrink-0'>Couldn&rsquo;t answer</span>
          : null}
      </div>

      {thinking
        ? (
          <div className='space-y-1.5' aria-hidden='true'>
            <div className='rp-shimmer bg-surface-3 h-3 w-full rounded-[4px]' />
            <div className='rp-shimmer bg-surface-3 h-3 w-5/6 rounded-[4px]' />
          </div>
        )
        : (
          <p className='rp-clamp-4 text-sm leading-relaxed text-ink-2'>
            {state.error ?? state.text}
          </p>
        )}

      {state.groundedness !== null
        ? (
          <TrustSignals
            quality={{
              answerRelevance: null,
              groundedness: state.groundedness,
              contextRelevance: null,
            }}
          />
        )
        : null}

      <Link
        to={`/t/${slug}/assistant?ask=${encodeURIComponent(query)}`}
        className='rp-focus mt-auto inline-flex items-center gap-1.5 self-start text-sm font-medium transition-colors duration-150'
        style={{ color: 'var(--rp-accent)' }}
      >
        Continue in {name}
        <span aria-hidden='true'>&rarr;</span>
      </Link>
    </div>
  )
}

/**
 * The flagship "federated estate" moment: one question, asked across every
 * enabled portal at once, each answering independently and in parallel.
 */
function EstateAsk({ tenants }: { tenants: TenantSummary[] | undefined }) {
  const [draft, setDraft] = useState('')
  const [askedQuery, setAskedQuery] = useState('')
  const [asking, setAsking] = useState(false)
  const [estateDone, setEstateDone] = useState(false)
  const [order, setOrder] = useState<string[]>([])
  const [results, setResults] = useState<Record<string, PortalAskState>>({})
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const tenantBySlug = new Map((tenants ?? []).map((tenant) => [tenant.slug, tenant]))

  function onEvent({ slug, event }: EstateEvent) {
    if (slug === null) {
      if (event.type === 'estate-done') {
        setEstateDone(true)
        setAsking(false)
      }
      return
    }

    setResults((prev) => {
      const existing = prev[slug] ?? emptyPortalState()
      const next: PortalAskState = { ...existing }
      if (event.type === 'delta') next.text += event.text
      else if (event.type === 'quality') next.groundedness = event.groundedness
      else if (event.type === 'error') next.error = event.message
      else if (event.type === 'done') next.done = true
      return { ...prev, [slug]: next }
    })
    setOrder((prev) => (prev.includes(slug) ? prev : [...prev, slug]))
  }

  function handleSubmit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault()
    const trimmed = draft.trim()
    if (trimmed.length === 0 || asking) return

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setAskedQuery(trimmed)
    setOrder([])
    setResults({})
    setEstateDone(false)
    setAsking(true)

    streamEstateAsk(trimmed, onEvent, controller.signal)
      .catch(() => {
        if (controller.signal.aborted) return
        setAsking(false)
      })
  }

  const hasAsked = askedQuery.length > 0

  return (
    <div className='mt-8'>
      <div className='rp-card p-5 sm:p-6'>
        <p className='rp-eyebrow text-ink-3'>Ask everything at once</p>
        <h2 className='rp-display mt-1.5 text-xl text-ink sm:text-2xl'>
          Ask across every knowledge box
        </h2>
        <p className='mt-2 max-w-xl text-sm leading-relaxed text-ink-2'>
          One question, every portal - each corpus answers on its own, side by side.
        </p>

        <form onSubmit={handleSubmit} className='mt-4'>
          <label htmlFor='estate-ask-input' className='sr-only'>
            Ask a question across every portal
          </label>
          <div className='rp-shadow-sm flex items-center gap-2 rounded-[8px] border border-line bg-surface p-1.5 pl-3'>
            <svg
              viewBox='0 0 20 20'
              fill='none'
              stroke='currentColor'
              strokeWidth='1.8'
              strokeLinecap='round'
              aria-hidden='true'
              className='h-4 w-4 shrink-0 text-ink-3'
            >
              <circle cx='9' cy='9' r='5.5' />
              <path d='M13.2 13.2L17 17' />
            </svg>
            <input
              id='estate-ask-input'
              type='text'
              autoComplete='off'
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder='Ask a question - it goes to every enabled portal'
              className='min-w-0 flex-1 border-0 bg-transparent px-1.5 py-1.5 text-sm text-ink placeholder:text-[var(--rp-ink-3)] focus:outline-none'
            />
            <button
              type='submit'
              disabled={asking || draft.trim().length === 0}
              className='rp-btn rp-btn-primary shrink-0 font-semibold'
            >
              {asking ? 'Asking…' : 'Ask'}
            </button>
          </div>
        </form>

        {hasAsked
          ? (
            <div className='mt-5 border-t border-line pt-5'>
              <div className='flex items-center justify-between gap-3'>
                <p className='text-sm font-medium text-ink-2'>
                  &ldquo;{askedQuery}&rdquo;
                </p>
                <p className='shrink-0 text-xs font-medium text-ink-3'>
                  {asking
                    ? (order.length === 0 ? 'Asking every portal…' : `${order.length} responding…`)
                    : `${order.length} ${order.length === 1 ? 'portal' : 'portals'} responded`}
                </p>
              </div>

              {order.length === 0 && asking
                ? (
                  <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2'>
                    <Skeleton className='h-32' />
                    <Skeleton className='h-32' />
                  </div>
                )
                : null}

              {order.length > 0
                ? (
                  <div className='mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2'>
                    {order.map((slug) => (
                      <EstatePortalCard
                        key={slug}
                        slug={slug}
                        tenant={tenantBySlug.get(slug)}
                        state={results[slug] ?? emptyPortalState()}
                        query={askedQuery}
                      />
                    ))}
                  </div>
                )
                : null}

              {!asking && estateDone && order.length === 0
                ? (
                  <p className='mt-4 text-sm text-ink-3'>
                    No portal was able to answer that one.
                  </p>
                )
                : null}
            </div>
          )
          : null}
      </div>
    </div>
  )
}

export function TenantPicker() {
  const { data: tenants, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tenants'],
    queryFn: getTenants,
  })

  return (
    <main className='min-h-screen bg-app px-6 py-10'>
      <div className='mx-auto w-full max-w-4xl'>
        <div className='flex items-start justify-between gap-4'>
          <header className='min-w-0'>
            <p className='rp-eyebrow text-ink-3'>Research Portal</p>
            <h1 className='rp-display mt-2 text-3xl text-ink sm:text-4xl'>
              Choose a portal
            </h1>
            <p className='mt-2 max-w-lg text-sm leading-relaxed text-ink-2'>
              Each portal is a corpus of its own - its own knowledge box, taxonomy and branding.
            </p>
          </header>
          <ThemeToggle />
        </div>

        {!isLoading && !isError && tenants && tenants.length > 0
          ? <EstateAsk tenants={tenants} />
          : null}

        <div className='mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2'>
          {isLoading
            ? (
              <>
                <Skeleton className='h-36' />
                <Skeleton className='h-36' />
              </>
            )
            : null}

          {isError
            ? (
              <div className='sm:col-span-2'>
                <ErrorCard
                  message={error instanceof Error ? error.message : 'Could not load portals.'}
                  onRetry={() => void refetch()}
                />
              </div>
            )
            : null}

          {!isLoading && !isError && tenants && tenants.length === 0
            ? (
              <div className='sm:col-span-2'>
                <EmptyState
                  title='No portals are configured yet'
                  description='Check back once a tenant has been provisioned.'
                />
              </div>
            )
            : null}

          {!isLoading && !isError && tenants
            ? tenants.map((tenant) => (
              <Link
                key={tenant.slug}
                to={`/t/${tenant.slug}`}
                className='rp-card rp-lift rp-focus group flex flex-col justify-between p-5'
              >
                <div>
                  <h2 className='text-base font-semibold tracking-[-0.01em] text-ink'>
                    {tenant.productName}
                  </h2>
                  <p className='rp-eyebrow mt-1.5 text-ink-3'>{tenant.organisation}</p>
                </div>
                <p className='rp-clamp-3 mt-5 text-sm leading-relaxed text-ink-2'>
                  {tenant.tagline}
                </p>
              </Link>
            ))
            : null}
        </div>

        <div className='mt-8 border-t border-line pt-4'>
          <Link to='/admin' className='rp-btn rp-btn-ghost -ml-3.5'>
            Administration
          </Link>
        </div>
      </div>
    </main>
  )
}
