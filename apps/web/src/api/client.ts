import type {
  Question,
  ResourceSummary,
  SearchResults,
  TenantConfig,
  TenantSummary,
} from '@research-portal/core'

/**
 * Typed error thrown by every helper below. Carries the HTTP status so callers
 * (e.g. TenantLayout) can branch on 404 vs other failures.
 */
export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string): Promise<T> {
  const res = await fetch(path)

  if (!res.ok) {
    let message = res.statusText || 'Request failed'
    try {
      const body: unknown = await res.json()
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
        message = body.error
      }
    } catch {
      // Body wasn't JSON - fall back to statusText.
    }
    throw new ApiError(res.status, message)
  }

  return (await res.json()) as T
}

export function getTenants(): Promise<TenantSummary[]> {
  return request<TenantSummary[]>('/api/tenants')
}

export function getTenantConfig(slug: string): Promise<TenantConfig> {
  return request<TenantConfig>(`/api/t/${encodeURIComponent(slug)}/config`)
}

export function searchTenant(slug: string, query: string): Promise<SearchResults> {
  const params = new URLSearchParams({ q: query })
  return request<SearchResults>(`/api/t/${encodeURIComponent(slug)}/search?${params.toString()}`)
}

export function getSuggestedQuestions(slug: string): Promise<Question[]> {
  return request<Question[]>(`/api/t/${encodeURIComponent(slug)}/suggest`)
}

export function getResources(slug: string): Promise<ResourceSummary[]> {
  return request<ResourceSummary[]>(`/api/t/${encodeURIComponent(slug)}/resources`)
}

export function getResource(slug: string, id: string): Promise<ResourceSummary> {
  return request<ResourceSummary>(
    `/api/t/${encodeURIComponent(slug)}/resources/${encodeURIComponent(id)}`,
  )
}
