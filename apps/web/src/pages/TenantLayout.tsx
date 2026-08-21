import { type CSSProperties, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, NavLink, Outlet, useParams } from 'react-router-dom'
import type { TenantConfig } from '@research-portal/core'
import { ApiError, getKnowledgeBoxStatus, getTenantConfig } from '../api/client.ts'

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

export function TenantLayout() {
  const { slug } = useParams<{ slug: string }>()
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
        <h1 className='text-2xl font-semibold tracking-tight text-neutral-900'>
          {notFound ? 'This portal does not exist' : 'Something went wrong'}
        </h1>
        <p className='mt-2 max-w-sm text-sm text-neutral-500'>
          {notFound
            ? 'Check the address, or head back and choose a portal from the list.'
            : error instanceof Error
            ? error.message
            : 'We could not load this portal right now.'}
        </p>
        <Link
          to='/'
          className='mt-6 inline-flex items-center rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900'
        >
          Back to portals
        </Link>
      </main>
    )
  }

  const { colours } = config.branding

  // Accent is arbitrary per-tenant data, so the active state relies on a dark, guaranteed-legible
  // text colour plus an accent underline rather than an accent background (which could be light,
  // e.g. GRDC's gold, and fail contrast against white text).
  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `border-b-2 px-1 py-1.5 text-sm font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${
      isActive ? 'text-neutral-900' : 'border-transparent text-neutral-500 hover:text-neutral-900'
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
      <header className='border-b border-neutral-200 bg-white/80 backdrop-blur'>
        <div className='mx-auto flex max-w-6xl items-center justify-between px-6 py-4'>
          <div className='flex items-center gap-3'>
            <Link
              to={`/t/${config.slug}`}
              className='text-lg font-semibold tracking-tight text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
              style={{ outlineColor: 'var(--rp-accent)' }}
            >
              {config.branding.productName}
            </Link>
            {kbStatus?.status === 'demo' && (
              <Link
                to='/admin'
                className='inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-800 transition-colors duration-150 hover:bg-amber-100'
                title='This portal is running on the demo knowledge box - click to connect the real one'
              >
                Demo only
              </Link>
            )}
            {kbStatus?.status === 'none' && (
              <Link
                to='/admin'
                className='inline-flex items-center rounded-full border border-neutral-300 bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-600 transition-colors duration-150 hover:bg-neutral-200'
              >
                Not connected
              </Link>
            )}
          </div>
          <nav aria-label='Primary' className='flex items-center gap-5'>
            <NavLink
              to={`/t/${config.slug}`}
              end
              className={navLinkClass}
              style={({ isActive }) => ({
                borderColor: isActive ? 'var(--rp-accent)' : undefined,
                outlineColor: 'var(--rp-accent)',
              })}
            >
              Explore
            </NavLink>
            <NavLink
              to={`/t/${config.slug}/search`}
              className={navLinkClass}
              style={({ isActive }) => ({
                borderColor: isActive ? 'var(--rp-accent)' : undefined,
                outlineColor: 'var(--rp-accent)',
              })}
            >
              Search
            </NavLink>
          </nav>
        </div>
      </header>
      <Outlet context={{ config } satisfies TenantOutletContext} />
    </div>
  )
}
