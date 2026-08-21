import type { ReactNode } from 'react'
import type { ResourceType } from '@research-portal/core'

/** A pulsing placeholder block used across loading states. */
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-lg bg-neutral-200 ${className}`} aria-hidden='true' />
  )
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
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
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
    <div className='rounded-2xl border border-neutral-200 bg-white p-6 text-center shadow-sm'>
      <p className='text-sm font-medium text-neutral-900'>Something went wrong</p>
      <p className='mt-1 text-sm text-neutral-500'>{message}</p>
      <button
        type='button'
        onClick={onRetry}
        className='mt-4 inline-flex items-center rounded-full px-4 py-2 text-sm font-medium text-white transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
        style={{ backgroundColor: 'var(--rp-primary)', outlineColor: 'var(--rp-accent)' }}
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
      <p className='text-sm font-medium text-neutral-900'>{title}</p>
      {description ? <p className='mt-1 text-sm text-neutral-500'>{description}</p> : null}
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
