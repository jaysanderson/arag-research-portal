import { type CSSProperties, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom'
import type { TenantConfig } from '@research-portal/core'
import { ApiError, getKnowledgeBoxStatus, getTenantConfig } from '../api/client.ts'
import { KbSwitcher } from '../components/KbSwitcher.tsx'
import { ThemeToggle } from '../components/ThemeToggle.tsx'

export type TenantOutletContext = {
  config: TenantConfig
}

function FullPageSpinner() {
  return (
    <div className='flex min-h-screen items-center justify-center bg-app' role='status'>
      <div
        className='h-9 w-9 animate-spin rounded-full border-2 border-line'
        style={{ borderTopColor: 'var(--rp-ink)' }}
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
  { path: '/manage', label: 'Manage', end: false },
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
      <main className='flex min-h-screen flex-col items-center justify-center bg-app px-6 text-center'>
        <h1 className='rp-display text-3xl text-ink'>
          {notFound ? 'This portal does not exist' : 'Something went wrong'}
        </h1>
        <p className='mt-3 max-w-sm text-sm leading-relaxed text-ink-2'>
          {notFound
            ? 'Check the address, or head back and choose a portal from the list.'
            : error instanceof Error
            ? error.message
            : 'We could not load this portal right now.'}
        </p>
        <Link to='/' className='rp-btn rp-btn-primary mt-6'>
          Back to portals
        </Link>
      </main>
    )
  }

  const { colours } = config.branding

  // Accent is arbitrary per-tenant data, so the active state pairs a guaranteed
  // legible ink colour with a 12% accent wash and an accent border rather than
  // a solid accent fill (which could be light, e.g. GRDC's gold, and fail
  // contrast against white text).
  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `rp-focus rounded-[6px] border px-2.5 py-1.5 text-sm font-medium transition-colors duration-150 ${
      isActive
        ? 'border-transparent text-ink'
        : 'border-transparent text-[var(--rp-ink-3)] hover:bg-[var(--rp-surface-2)] hover:text-[var(--rp-ink)]'
    }`

  const navLinkStyle = ({ isActive }: { isActive: boolean }): CSSProperties =>
    isActive
      ? {
        borderColor: 'var(--rp-accent)',
        backgroundColor: 'color-mix(in srgb, var(--rp-accent) 12%, transparent)',
      }
      : {}

  return (
    <div
      className='min-h-screen bg-app'
      style={{
        '--rp-primary': colours.primary,
        '--rp-accent': colours.accent,
        '--rp-hero-from': colours.heroFrom,
        '--rp-hero-to': colours.heroTo,
      } as CSSProperties}
    >
      <header className='rp-glass sticky top-0 z-40 border-b border-line'>
        <div className='mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-2.5'>
          <div className='flex shrink-0 items-center gap-2.5'>
            <KbSwitcher config={config} />
            {kbStatus?.status === 'demo' && (
              <span className='hidden shrink-0 lg:block'>
                <Link
                  to='/admin'
                  className='rp-badge rp-badge-warn rp-focus'
                  title='This portal is running on the demo knowledge box - click to connect the real one'
                >
                  Demo only
                </Link>
              </span>
            )}
            {kbStatus?.status === 'none' && (
              <span className='hidden shrink-0 lg:block'>
                <Link to='/admin' className='rp-badge rp-badge-quiet rp-focus'>
                  Not connected
                </Link>
              </span>
            )}
          </div>
          <div className='flex min-w-0 items-center gap-2'>
            <nav
              aria-label='Primary'
              className='rp-no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto whitespace-nowrap py-1'
            >
              {NAV_ITEMS.map((item) => (
                <NavLink
                  key={item.label}
                  to={`/t/${config.slug}${item.path}`}
                  end={item.end}
                  className={navLinkClass}
                  style={navLinkStyle}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
            <span className='h-5 w-px shrink-0 bg-[var(--rp-line)]' aria-hidden='true' />
            <ThemeToggle />
          </div>
        </div>
      </header>
      {/* Keyed on the path so each route change replays the entrance. */}
      <div key={location.pathname} className='rp-page-enter'>
        <Outlet context={{ config } satisfies TenantOutletContext} />
      </div>
    </div>
  )
}
