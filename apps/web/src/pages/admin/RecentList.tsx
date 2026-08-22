import { useQuery } from '@tanstack/react-query'
import type { RecentResource } from '@research-portal/core'
import { getAdminRecent } from '../../api/client.ts'
import { Skeleton } from '../../components/ui.tsx'

function StatusChip({ status }: { status: RecentResource['status'] }) {
  if (status === 'pending') {
    return (
      <span className='rp-badge rp-badge-warn'>
        <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--rp-warn-ink)]' />
        Processing
      </span>
    )
  }
  if (status === 'processed') {
    return <span className='rp-badge rp-badge-ok'>Indexed</span>
  }
  return <span className='rp-badge rp-badge-bad'>Error</span>
}

/**
 * Recently added resources for a tenant, polling every four seconds while
 * anything is still pending so the "Processing" chip flips to "Indexed"
 * without a manual refresh.
 */
export function RecentList({ slug, passcode }: { slug: string; passcode: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-recent', slug],
    queryFn: () => getAdminRecent(slug, passcode),
    refetchInterval: (query) =>
      query.state.data?.some((r) => r.status === 'pending') ? 4000 : false,
  })

  return (
    <div>
      <h3 className='text-sm font-medium text-ink'>Recent additions</h3>

      {isLoading && (
        <div className='mt-2 space-y-2'>
          <Skeleton className='h-10 w-full' />
          <Skeleton className='h-10 w-full' />
        </div>
      )}

      {isError && <p className='mt-2 text-sm text-ink-3'>Could not load recent additions.</p>}

      {data && data.length === 0 && <p className='mt-2 text-sm text-ink-3'>Nothing added yet.</p>}

      {data && data.length > 0 && (
        <ul className='mt-2 divide-y divide-line overflow-hidden rounded-[var(--rp-radius)] border border-line'>
          {data.map((resource) => (
            <li
              key={resource.id}
              className='flex items-center justify-between gap-3 bg-surface px-4 py-2.5'
            >
              <span className='truncate text-sm text-ink'>{resource.title}</span>
              <span className='flex shrink-0 items-center gap-3'>
                {resource.created && (
                  <span className='text-xs text-ink-3'>{resource.created.slice(0, 10)}</span>
                )}
                <StatusChip status={resource.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
