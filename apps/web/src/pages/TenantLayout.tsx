import { type CSSProperties, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom'
import type { TenantConfig } from '@research-portal/core'
import { ApiError, getKnowledgeBoxStatus, getTenantConfig } from '../api/client.ts'
import { KbSwitcher } from '../components/KbSwitcher.tsx'
import { ThemeToggle } from '../components/ThemeToggle.tsx'
import { CommandPalette } from '../components/CommandPalette.tsx'

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
  { path: '/investigations', label: 'Investigations', end: false },
  { path: '/generate', label: 'Generate', end: false },
  { path: '/assessment', label: 'Assessment', end: false },
  { path: '/graph', label: 'Graph', end: false },
  { path: '/help', label: 'Help', end: false },
  { path: '/manage', label: 'Manage', end: false },
]

export function TenantLayout() {
  const { slug } = useParams<{ slug: string }>()
  const location = useLocation()
  const [navOpen, setNavOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)

  // Cmd/Ctrl+K opens the search-or-ask palette from anywhere in the portal.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(true)
      }
    }
    globalThis.addEventListener('keydown', onKey)
    return () => globalThis.removeEventListener('keydown', onKey)
  }, [])

  // The mobile nav sheet closes on navigation, on Escape, and locks page
  // scroll behind it while open.
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname])

  // The palette closes itself once it navigates - this only catches a route
  // change from elsewhere (e.g. browser back) while it happens to be open.
  useEffect(() => {
    setPaletteOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (!navOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navOpen])

  useEffect(() => {
    if (!navOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [navOpen])
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
        <div className='rp-shell flex items-center justify-between gap-4 py-2.5'>
          <div className='flex min-w-0 shrink-0 items-center gap-2.5'>
            <KbSwitcher config={config} />
            {kbStatus?.status === 'demo' && (
              <span className='hidden shrink-0 lg:block'>
                <Link
                  to='/admin'
                  className='rp-badge rp-badge-warn rp-focus'
                  title='This portal is running on demonstration content - click to connect the real one'
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
          <div className='hidden min-w-0 items-center gap-2 md:flex'>
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
          <button
            type='button'
            onClick={() => setNavOpen(true)}
            aria-label='Open menu'
            aria-haspopup='dialog'
            aria-expanded={navOpen}
            className='rp-btn rp-btn-ghost h-9 w-9 shrink-0 !px-0 md:hidden'
          >
            <svg
              viewBox='0 0 20 20'
              fill='none'
              stroke='currentColor'
              strokeWidth='1.7'
              strokeLinecap='round'
              className='h-4 w-4'
              aria-hidden='true'
            >
              <path d='M3 5.5h14M3 10h14M3 14.5h14' />
            </svg>
          </button>
        </div>
      </header>

      {navOpen && (
        <div
          role='dialog'
          aria-modal='true'
          aria-label='Menu'
          className='rp-anim-fade fixed inset-0 z-50 flex flex-col bg-app md:hidden'
        >
          <div className='flex shrink-0 items-center justify-between border-b border-line px-4 py-3'>
            <span className='text-sm font-semibold text-ink'>Menu</span>
            <button
              type='button'
              onClick={() => setNavOpen(false)}
              aria-label='Close menu'
              className='rp-btn rp-btn-ghost h-9 w-9 !px-0'
            >
              <svg viewBox='0 0 20 20' fill='currentColor' aria-hidden='true' className='h-4 w-4'>
                <path d='M5.3 4.3l4.7 4.7 4.7-4.7 1 1L11 10l4.7 4.7-1 1L10 11l-4.7 4.7-1-1L9 10 4.3 5.3z' />
              </svg>
            </button>
          </div>

          <nav aria-label='Primary' className='flex-1 overflow-y-auto px-3 py-3'>
            <ul className='space-y-1'>
              {NAV_ITEMS.map((item) => (
                <li key={item.label}>
                  <NavLink
                    to={`/t/${config.slug}${item.path}`}
                    end={item.end}
                    className={({ isActive }) =>
                      `rp-btn rp-btn-ghost h-12 w-full justify-start rounded-[8px] border px-4 text-base ${
                        isActive ? 'border-transparent text-ink' : 'border-transparent'
                      }`}
                    style={navLinkStyle}
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>

          <div className='flex shrink-0 items-center justify-between gap-3 border-t border-line px-4 py-4'>
            {kbStatus?.status === 'demo'
              ? (
                <Link
                  to='/admin'
                  onClick={() => setNavOpen(false)}
                  className='rp-badge rp-badge-warn rp-focus'
                >
                  Demo only
                </Link>
              )
              : kbStatus?.status === 'none'
              ? (
                <Link
                  to='/admin'
                  onClick={() => setNavOpen(false)}
                  className='rp-badge rp-badge-quiet rp-focus'
                >
                  Not connected
                </Link>
              )
              : <span />}
            <ThemeToggle />
          </div>
        </div>
      )}
      {/* Keyed on the path so each route change replays the entrance. */}
      <div key={location.pathname} className='rp-page-enter'>
        <Outlet context={{ config } satisfies TenantOutletContext} />
      </div>

      {paletteOpen
        ? (
          <CommandPalette
            slug={config.slug}
            suggestedQuestions={config.suggestedQuestions}
            onClose={() => setPaletteOpen(false)}
          />
        )
        : null}
    </div>
  )
}
