import type { ReactNode } from 'react'
import type { ResourceType } from '@research-portal/core'

/**
 * A placeholder block used across loading states. A travelling shimmer rather
 * than a flat pulse, so a page of skeletons reads as one loading surface.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`rp-shimmer rounded-lg ${className}`} aria-hidden='true' />
}

const TYPE_LABELS: Record<ResourceType, string> = {
  document: 'Report',
  pdf: 'PDF',
  video: 'Video',
  web: 'Web',
}

const TYPE_STYLES: Record<ResourceType, string> = {
  document: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  pdf: 'bg-rose-50 text-rose-700 ring-rose-200',
  video: 'bg-violet-50 text-violet-700 ring-violet-200',
  web: 'bg-sky-50 text-sky-700 ring-sky-200',
}

/** Small pill showing the resource type - Report / PDF / Video / Web. */
export function TypeBadge({ type }: { type: ResourceType }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide ring-1 ring-inset ${
        TYPE_STYLES[type]
      }`}
    >
      {TYPE_LABELS[type]}
    </span>
  )
}

/** Inline error state with a retry action, used wherever a query can fail. */
export function ErrorCard({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className='rp-shadow-sm rounded-2xl border border-neutral-200/80 bg-white p-6 text-center'>
      <span
        aria-hidden='true'
        className='mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-rose-50 text-rose-600'
      >
        <svg viewBox='0 0 20 20' fill='currentColor' className='h-4 w-4'>
          <path
            fillRule='evenodd'
            d='M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.63-1.516 2.63H3.72c-1.347 0-2.189-1.463-1.515-2.63zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 8a1 1 0 100-2 1 1 0 000 2z'
            clipRule='evenodd'
          />
        </svg>
      </span>
      <p className='mt-3 text-sm font-semibold text-neutral-900'>Something went wrong</p>
      <p className='mt-1 text-sm leading-relaxed text-neutral-500'>{message}</p>
      <button
        type='button'
        onClick={onRetry}
        className='rp-focus mt-4 inline-flex items-center rounded-full px-4 py-2 text-sm font-medium text-white transition-transform duration-150 hover:-translate-y-px'
        style={{ backgroundColor: 'var(--rp-primary)' }}
      >
        Try again
      </button>
    </div>
  )
}

/** Honest empty state - message plus optional supporting content (e.g. suggestions). */
export function EmptyState(
  { title, description, children }: { title: string; description?: string; children?: ReactNode },
) {
  return (
    <div className='rounded-2xl border border-dashed border-neutral-300 bg-white/60 p-8 text-center'>
      <p className='text-sm font-semibold text-neutral-900'>{title}</p>
      {description
        ? (
          <p className='mx-auto mt-1 max-w-md text-sm leading-relaxed text-neutral-500'>
            {description}
          </p>
        )
        : null}
      {children ? <div className='mt-4'>{children}</div> : null}
    </div>
  )
}

/** Deterministic, pleasant muted hue derived from a resource id - used for thumbnail colour blocks. */
export function hueFromId(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  }
  return hash % 360
}
