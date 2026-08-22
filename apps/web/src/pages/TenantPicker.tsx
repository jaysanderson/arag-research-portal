import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getTenants } from '../api/client.ts'
import { EmptyState, ErrorCard, Skeleton } from '../components/ui.tsx'
import { ThemeToggle } from '../components/ThemeToggle.tsx'

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
