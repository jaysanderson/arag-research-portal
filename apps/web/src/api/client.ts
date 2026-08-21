import type {
  AdminTenantOverview,
  KbCounters,
  KnowledgeBoxStatus,
  MigrationEvent,
  Question,
  RecentResource,
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

/**
 * Provision a brand new knowledge box on the platform and connect this
 * tenant to it. Used both for tenants with no box yet and as a "start
 * fresh" affordance for tenants still on the demo box.
 */
export function createAdminKb(
  slug: string,
  passcode: string,
  title?: string,
): Promise<{ ok: boolean; status: KnowledgeBoxStatus }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/knowledge-box/create`, passcode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  })
}

export function getAdminCounters(slug: string, passcode: string): Promise<KbCounters> {
  return adminRequest<KbCounters>(`/api/admin/t/${encodeURIComponent(slug)}/counters`, passcode)
}

export function getAdminRecent(slug: string, passcode: string): Promise<RecentResource[]> {
  return adminRequest<RecentResource[]>(`/api/admin/t/${encodeURIComponent(slug)}/recent`, passcode)
}

export function addAdminLink(
  slug: string,
  passcode: string,
  input: { url: string; title?: string },
): Promise<{ id: string }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/resources/link`, passcode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function addAdminText(
  slug: string,
  passcode: string,
  input: { title: string; body: string },
): Promise<{ id: string }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/resources/text`, passcode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

/**
 * Upload a file's raw bytes. The file's own type drives the content-type
 * header and its name travels separately (URL-encoded) since a raw-byte
 * body can't carry multipart fields.
 */
export function uploadAdminFile(
  slug: string,
  passcode: string,
  file: File,
): Promise<{ id: string }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/resources/upload`, passcode, {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name),
    },
    body: file,
  })
}

/**
 * Run a knowledge-box migration and stream its progress. The response body
 * is a text/event-stream of `data: <MigrationEvent JSON>\n\n` frames; each
 * parsed event is handed to `onEvent` as it arrives.
 */
export async function migrateKb(
  from: string,
  to: string,
  passcode: string,
  onEvent: (event: MigrationEvent) => void,
): Promise<void> {
  const res = await fetch('/api/admin/migrate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-passcode': passcode,
    },
    body: JSON.stringify({ from, to }),
  })

  if (!res.ok || !res.body) {
    let message = res.statusText || 'Migration failed'
    try {
      const body: unknown = await res.json()
      if (
        body && typeof body === 'object' && 'message' in body &&
        typeof body.message === 'string'
      ) {
        message = body.message
      } else if (
        body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ) {
        message = body.error
      }
    } catch {
      // Body wasn't JSON - fall back to statusText.
    }
    throw new ApiError(res.status, message)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const emit = (frame: string) => {
    const line = frame.trim()
    if (!line) return
    const data = line.startsWith('data: ') ? line.slice('data: '.length) : line
    onEvent(JSON.parse(data) as MigrationEvent)
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) emit(frame)
  }
  emit(buffer)
}
