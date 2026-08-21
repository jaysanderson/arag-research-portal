import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getTenants } from '../api/client.ts'
import { EmptyState, ErrorCard, Skeleton } from '../components/ui.tsx'

export function TenantPicker() {
  const { data: tenants, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tenants'],
    queryFn: getTenants,
  })

  return (
    <main className='flex min-h-screen flex-col items-center bg-[#f7f7f5] px-6 py-20'>
      <div className='w-full max-w-3xl'>
        <header className='text-center'>
          <p className='text-sm font-semibold uppercase tracking-[0.2em] text-neutral-500'>
            Research Portal
          </p>
          <h1 className='mt-3 text-3xl font-semibold tracking-tight text-neutral-900 sm:text-4xl'>
            Choose a portal to continue
          </h1>
        </header>

        <div className='mt-12 grid grid-cols-1 gap-5 sm:grid-cols-2'>
          {isLoading
            ? (
              <>
                <Skeleton className='h-40 rounded-2xl' />
                <Skeleton className='h-40 rounded-2xl' />
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
                className='group flex flex-col justify-between rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900'
              >
                <div>
                  <h2 className='text-lg font-semibold tracking-tight text-neutral-900'>
                    {tenant.productName}
                  </h2>
                  <p className='mt-1 text-sm font-medium text-neutral-500'>
                    {tenant.organisation}
                  </p>
                </div>
                <p className='mt-6 text-sm leading-relaxed text-neutral-600'>{tenant.tagline}</p>
              </Link>
            ))
            : null}
        </div>
      </div>
    </main>
  )
}
