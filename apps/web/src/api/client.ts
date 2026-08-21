import type {
  AdminTenantOverview,
  AnalyseEvent,
  AskEvent,
  CatalogPage,
  FacetCounts,
  GenerateKind,
  GenerateResult,
  GraphData,
  KbCounters,
  KnowledgeBoxStatus,
  Labelset,
  MigrationEvent,
  Question,
  RecentResource,
  ResourceSummary,
  RetrievalMode,
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

export function searchTenantFull(
  slug: string,
  query: string,
  opts: { mode?: RetrievalMode; topicIds?: string[] } = {},
): Promise<SearchResults> {
  const params = new URLSearchParams({ q: query })
  if (opts.mode) params.set('mode', opts.mode)
  if (opts.topicIds && opts.topicIds.length > 0) params.set('topics', opts.topicIds.join(','))
  return request<SearchResults>(`/api/t/${encodeURIComponent(slug)}/search?${params.toString()}`)
}

export function getCatalog(
  slug: string,
  opts: {
    page?: number
    pageSize?: number
    query?: string
    topicIds?: string[]
    sort?: 'created' | 'modified' | 'title'
    order?: 'asc' | 'desc'
  } = {},
): Promise<CatalogPage> {
  const params = new URLSearchParams()
  if (opts.page) params.set('page', String(opts.page))
  if (opts.pageSize) params.set('pageSize', String(opts.pageSize))
  if (opts.query) params.set('q', opts.query)
  if (opts.topicIds && opts.topicIds.length > 0) params.set('topics', opts.topicIds.join(','))
  if (opts.sort) params.set('sort', opts.sort)
  if (opts.order) params.set('order', opts.order)
  return request<CatalogPage>(`/api/t/${encodeURIComponent(slug)}/catalog?${params.toString()}`)
}

export function getFacets(slug: string, labelsets: string[] = ['topic']): Promise<FacetCounts> {
  return request<FacetCounts>(
    `/api/t/${encodeURIComponent(slug)}/facets?ls=${labelsets.join(',')}`,
  )
}

export function getLabelsets(slug: string): Promise<Labelset[]> {
  return request<Labelset[]>(`/api/t/${encodeURIComponent(slug)}/labelsets`)
}

export function getCounters(slug: string): Promise<KbCounters> {
  return request<KbCounters>(`/api/t/${encodeURIComponent(slug)}/counters`)
}

export function getGraph(
  slug: string,
  primary = 'topic',
  secondary = 'kind',
): Promise<GraphData> {
  return request<GraphData>(
    `/api/t/${encodeURIComponent(slug)}/graph?primary=${primary}&secondary=${secondary}`,
  )
}

export function generateArtifact(
  slug: string,
  kind: GenerateKind,
  query: string,
): Promise<GenerateResult> {
  return fetch(`/api/t/${encodeURIComponent(slug)}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, query }),
  }).then(async (res) => {
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null)
      const message = body && typeof body === 'object' && 'message' in body &&
          typeof body.message === 'string'
        ? body.message
        : 'Generation failed - try a narrower request.'
      throw new ApiError(res.status, message)
    }
    return (await res.json()) as GenerateResult
  })
}

export interface AskRequest {
  query: string
  context?: { author: 'USER' | 'AGENT'; text: string }[]
  resourceId?: string
  topicIds?: string[]
}

/**
 * Stream a grounded answer. Events arrive in order: stage events, a sources
 * event, delta text chunks, citation events, optionally usage, then done (or
 * error). Returns when the stream closes; abort via the signal.
 */
export async function streamAsk(
  slug: string,
  body: AskRequest,
  onEvent: (event: AskEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/t/${encodeURIComponent(slug)}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, res.statusText || 'The answer service is unavailable')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = (frame: string) => {
    const line = frame.trim()
    if (!line) return
    const data = line.startsWith('data: ') ? line.slice('data: '.length) : line
    onEvent(JSON.parse(data) as AskEvent)
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
  input: { url: string; token: string; passcode: string },
): Promise<ConnectResult> {
  return adminRequest<ConnectResult>(
    `/api/admin/t/${encodeURIComponent(slug)}/knowledge-box`,
    input.passcode,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: input.url, token: input.token }),
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

export function discoverCrawl(
  slug: string,
  passcode: string,
  url: string,
  limit = 50,
): Promise<{ source: string; count: number; links: string[] }> {
  const params = new URLSearchParams({ url, limit: String(limit) })
  return adminRequest(
    `/api/admin/t/${encodeURIComponent(slug)}/crawl?${params.toString()}`,
    passcode,
  )
}

export function createAdminLabelset(
  slug: string,
  passcode: string,
  input: { title: string; multiple: boolean; labels: string[] },
): Promise<{ ok: boolean }> {
  return adminRequest(`/api/admin/t/${encodeURIComponent(slug)}/labelsets`, passcode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function addPortal(
  passcode: string,
  input: { name: string; organisation?: string; tagline?: string },
): Promise<{ ok: boolean; slug: string }> {
  return adminRequest('/api/admin/tenants', passcode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function removePortal(slug: string, passcode: string): Promise<{ ok: boolean }> {
  return adminRequest(`/api/admin/tenants/${encodeURIComponent(slug)}`, passcode, {
    method: 'DELETE',
  })
}

export function setPortalDisabled(
  slug: string,
  passcode: string,
  disabled: boolean,
): Promise<{ ok: boolean }> {
  return adminRequest(
    `/api/admin/t/${encodeURIComponent(slug)}/${disabled ? 'disable' : 'enable'}`,
    passcode,
    { method: 'POST' },
  )
}

/** Run corpus analysis and stream its progress events. */
export async function analysePortal(
  slug: string,
  passcode: string,
  onEvent: (event: AnalyseEvent) => void,
): Promise<void> {
  const res = await fetch(`/api/admin/t/${encodeURIComponent(slug)}/analyse`, {
    method: 'POST',
    headers: { 'x-admin-passcode': passcode },
  })
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, res.statusText || 'Analysis failed to start')
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const emit = (frame: string) => {
    const line = frame.trim()
    if (!line) return
    const data = line.startsWith('data: ') ? line.slice('data: '.length) : line
    onEvent(JSON.parse(data) as AnalyseEvent)
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
