import type {
  AdminTenantOverview,
  KnowledgeBoxStatus,
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

export function getKnowledgeBoxStatus(slug: string): Promise<KnowledgeBoxStatus> {
  return request<KnowledgeBoxStatus>(`/api/t/${encodeURIComponent(slug)}/knowledge-box`)
}

async function adminRequest<T>(path: string, passcode: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'x-admin-passcode': passcode,
    },
  })
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const message = body && typeof body === 'object' && 'message' in body &&
        typeof body.message === 'string'
      ? body.message
      : body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : 'Request failed'
    throw new ApiError(res.status, message)
  }
  return body as T
}

export function getAdminOverview(passcode: string): Promise<AdminTenantOverview[]> {
  return adminRequest<AdminTenantOverview[]>('/api/admin/overview', passcode)
}

export function revertKnowledgeBox(
  slug: string,
  passcode: string,
): Promise<{ ok: boolean; status: KnowledgeBoxStatus }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/knowledge-box`, passcode, {
    method: 'DELETE',
  })
}

export interface ConnectResult {
  ok: boolean
  status: KnowledgeBoxStatus
  resourceCount: number
}

/**
 * Connect a knowledge box to a tenant. The administrator types the KB id,
 * service-account token and admin passcode into the form themselves; values
 * go straight to the server and are never stored client-side.
 */
export function connectKnowledgeBox(
  slug: string,
  input: { kbId: string; token: string; passcode: string },
): Promise<ConnectResult> {
  return adminRequest<ConnectResult>(
    `/api/admin/t/${encodeURIComponent(slug)}/knowledge-box`,
    input.passcode,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kbId: input.kbId, token: input.token }),
    },
  )
}
