import { type CSSProperties, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom'
import type { TenantConfig } from '@research-portal/core'
import { ApiError, getKnowledgeBoxStatus, getTenantConfig } from '../api/client.ts'
import { KbSwitcher } from '../components/KbSwitcher.tsx'

export type TenantOutletContext = {
  config: TenantConfig
}

function FullPageSpinner() {
  return (
    <div className='flex min-h-screen items-center justify-center bg-[#f7f7f5]' role='status'>
      <div
        className='h-10 w-10 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900'
        aria-hidden='true'
      />
      <span className='sr-only'>Loading portal</span>
    </div>
  )
}

const NAV_ITEMS: { path: string; label: string; end: boolean }[] = [
  { path: '', label: 'Explore', end: true },
  { path: '/search', label: 'Search', end: false },
  { path: '/library', label: 'Library', end: false },
  { path: '/assistant', label: 'Assistant', end: false },
  { path: '/agentic', label: 'Agentic', end: false },
  { path: '/generate', label: 'Generate', end: false },
  { path: '/graph', label: 'Graph', end: false },
  { path: '/taxonomy', label: 'Taxonomy', end: false },
]

export function TenantLayout() {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const location = useLocation()

  // Cmd/Ctrl+K jumps to search from anywhere in the portal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (slug) navigate(`/t/${slug}/search`)
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [slug, navigate])
  const {
    data: config,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['tenant-config', slug],
    queryFn: () => getTenantConfig(slug ?? ''),
    enabled: Boolean(slug),
  })

  const { data: kbStatus } = useQuery({
    queryKey: ['kb-status', slug],
    queryFn: () => getKnowledgeBoxStatus(slug ?? ''),
    enabled: Boolean(slug),
  })

  useEffect(() => {
    if (config) {
      document.title = config.branding.productName
    }
    return () => {
      document.title = 'Research Portal'
    }
  }, [config])

  if (isLoading) {
    return <FullPageSpinner />
  }

  if (isError || !config) {
    const notFound = error instanceof ApiError && error.status === 404

    return (
      <main className='flex min-h-screen flex-col items-center justify-center bg-[#f7f7f5] px-6 text-center'>
        <h1 className='rp-display text-3xl text-neutral-900'>
          {notFound ? 'This portal does not exist' : 'Something went wrong'}
        </h1>
        <p className='mt-3 max-w-sm text-sm leading-relaxed text-neutral-500'>
          {notFound
            ? 'Check the address, or head back and choose a portal from the list.'
            : error instanceof Error
            ? error.message
            : 'We could not load this portal right now.'}
        </p>
        <Link
          to='/'
          className='rp-focus mt-6 inline-flex items-center rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800'
        >
          Back to portals
        </Link>
      </main>
    )
  }

  const { colours } = config.branding

  // Accent is arbitrary per-tenant data, so the active state relies on a dark,
  // guaranteed-legible text colour on a quiet neutral pill plus an accent
  // underline rather than an accent background (which could be light, e.g.
  // GRDC's gold, and fail contrast against white text).
  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `rp-focus relative rounded-full px-3 py-1.5 text-sm font-medium transition-colors duration-150 ${
      isActive
        ? 'bg-neutral-900/[0.06] text-neutral-900'
        : 'text-neutral-500 hover:bg-neutral-900/[0.035] hover:text-neutral-900'
    }`

  return (
    <div
      className='min-h-screen bg-[#f7f7f5]'
      style={{
        '--rp-primary': colours.primary,
        '--rp-accent': colours.accent,
        '--rp-hero-from': colours.heroFrom,
        '--rp-hero-to': colours.heroTo,
      } as CSSProperties}
    >
      <header className='rp-glass sticky top-0 z-40 border-b border-neutral-900/[0.07]'>
        <div className='mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3'>
          <div className='flex min-w-0 items-center gap-3'>
            <KbSwitcher config={config} />
            {kbStatus?.status === 'demo' && (
              <Link
                to='/admin'
                className='rp-focus hidden items-center rounded-full border border-amber-200 bg-amber-50/80 px-2.5 py-0.5 text-xs font-medium text-amber-800 transition-colors duration-150 hover:bg-amber-100 sm:inline-flex'
                title='This portal is running on the demo knowledge box - click to connect the real one'
              >
                Demo only
              </Link>
            )}
            {kbStatus?.status === 'none' && (
              <Link
                to='/admin'
                className='rp-focus hidden items-center rounded-full border border-neutral-300 bg-neutral-100/80 px-2.5 py-0.5 text-xs font-medium text-neutral-600 transition-colors duration-150 hover:bg-neutral-200 sm:inline-flex'
              >
                Not connected
              </Link>
            )}
          </div>
          <nav
            aria-label='Primary'
            className='rp-no-scrollbar -mr-2 flex items-center gap-0.5 overflow-x-auto whitespace-nowrap py-1.5 pr-2'
          >
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.label}
                to={`/t/${config.slug}${item.path}`}
                end={item.end}
                className={navLinkClass}
              >
                {({ isActive }) => (
                  <>
                    {item.label}
                    <span
                      aria-hidden='true'
                      className={`pointer-events-none absolute inset-x-3 -bottom-1 h-[2px] rounded-full transition-opacity duration-150 ${
                        isActive ? 'opacity-100' : 'opacity-0'
                      }`}
                      style={{ backgroundColor: 'var(--rp-accent)' }}
                    />
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      {/* Keyed on the path so each route change replays the entrance. */}
      <div key={location.pathname} className='rp-page-enter'>
        <Outlet context={{ config } satisfies TenantOutletContext} />
      </div>
    </div>
  )
}
