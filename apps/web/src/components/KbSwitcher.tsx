import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { KnowledgeBoxStatus, TenantConfig } from '@research-portal/core'
import { getKnowledgeBoxStatus, getTenants } from '../api/client.ts'

function StatusDot({ status }: { status?: KnowledgeBoxStatus['status'] }) {
  const colour = status === 'connected'
    ? 'bg-emerald-500'
    : status === 'demo'
    ? 'bg-amber-400'
    : 'bg-neutral-300'
  return <span className={`h-2 w-2 shrink-0 rounded-full ${colour}`} aria-hidden='true' />
}

/**
 * The knowledge box switcher: the portal wordmark doubles as a dropdown that
 * switches between every portal (each backed by its own knowledge box) and
 * links to the management screen.
 */
export function KbSwitcher({ config }: { config: TenantConfig }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const location = useLocation()

  const { data: tenants } = useQuery({ queryKey: ['tenants'], queryFn: getTenants })
  const { data: statuses } = useQuery({
    queryKey: ['kb-statuses', tenants?.map((t) => t.slug).join(',')],
    enabled: open && Boolean(tenants && tenants.length > 0),
    queryFn: async () => {
      const entries = await Promise.all(
        (tenants ?? []).map(async (t) => {
          try {
            return [t.slug, await getKnowledgeBoxStatus(t.slug)] as const
          } catch {
            return [t.slug, undefined] as const
          }
        }),
      )
      return Object.fromEntries(entries) as Record<string, KnowledgeBoxStatus | undefined>
    },
  })

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  const switchTo = (slug: string) => {
    setOpen(false)
    if (slug === config.slug) return
    // Keep the current section when switching boxes, e.g. /search stays /search.
    const section = location.pathname.replace(new RegExp(`^/t/${config.slug}`), '')
    navigate(`/t/${slug}${section}${location.search}`)
  }

  return (
    <div ref={wrapRef} className='relative'>
      <button
        type='button'
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup='menu'
        aria-expanded={open}
        className='flex items-center gap-2 rounded-xl px-2 py-1 text-lg font-semibold tracking-tight text-neutral-900 transition-colors duration-150 hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
        style={{ outlineColor: 'var(--rp-accent)' }}
      >
        {config.branding.productName}
        <svg
          className={`h-4 w-4 text-neutral-400 transition-transform duration-150 ${
            open ? 'rotate-180' : ''
          }`}
          viewBox='0 0 20 20'
          fill='currentColor'
          aria-hidden='true'
        >
          <path
            fillRule='evenodd'
            d='M5.23 7.21a.75.75 0 011.06.02L10 10.94l3.71-3.71a.75.75 0 111.06 1.06l-4.24 4.24a.75.75 0 01-1.06 0L5.23 8.29a.75.75 0 010-1.08z'
            clipRule='evenodd'
          />
        </svg>
      </button>

      {open && (
        <div
          role='menu'
          className='absolute left-0 top-full z-30 mt-2 w-72 rounded-2xl border border-neutral-200 bg-white p-2 shadow-lg'
        >
          <p className='px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-neutral-400'>
            Knowledge boxes
          </p>
          {(tenants ?? []).map((t) => (
            <button
              key={t.slug}
              type='button'
              role='menuitem'
              onClick={() => switchTo(t.slug)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors duration-150 hover:bg-neutral-50 ${
                t.slug === config.slug ? 'bg-neutral-50' : ''
              }`}
            >
              <StatusDot status={statuses?.[t.slug]?.status} />
              <span className='min-w-0 flex-1'>
                <span className='block truncate text-sm font-medium text-neutral-900'>
                  {t.productName}
                </span>
                <span className='block truncate text-xs text-neutral-500'>{t.organisation}</span>
              </span>
              {t.slug === config.slug && (
                <span className='text-xs font-medium' style={{ color: 'var(--rp-accent)' }}>
                  ✓
                </span>
              )}
            </button>
          ))}
          <div className='my-2 border-t border-neutral-100' />
          <Link
            to='/admin'
            role='menuitem'
            onClick={() => setOpen(false)}
            className='flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-neutral-700 transition-colors duration-150 hover:bg-neutral-50'
          >
            <span aria-hidden='true' className='text-neutral-400'>+</span>
            Add a knowledge box
          </Link>
          <Link
            to='/admin'
            role='menuitem'
            onClick={() => setOpen(false)}
            className='flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-neutral-700 transition-colors duration-150 hover:bg-neutral-50'
          >
            <span aria-hidden='true' className='text-neutral-400'>⚙</span>
            Manage knowledge boxes
          </Link>
        </div>
      )}
    </div>
  )
}
