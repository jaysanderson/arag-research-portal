import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  AdminTenantOverviewSchema,
  type AskEvent,
  AskEventSchema,
  type CatalogPage,
  type FacetCounts,
  type Labelset,
  type Question,
  type ResourceSummary,
  type SearchResults,
  SearchResultsSchema,
  type TenantConfig,
  TenantConfigSchema,
} from '@research-portal/core'
import type { RetrievalProvider } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { TenantStore } from './tenants.ts'

// Hermetic tenant store - tests must never read the repo's live data/tenants.json.
const freshTenants = () =>
  new TenantStore({ TENANTS_PATH: `${Deno.makeTempDirSync()}/tenants.json` })
import { BindingStore } from './bindings.ts'

// ---------------------------------------------------------------------------
// StubProvider - a deterministic, in-memory RetrievalProvider double used only
// in tests. It never ships in product code; the API server always gets a real
// provider (currently `createProviderFromEnv`) injected via `buildApp`.
// ---------------------------------------------------------------------------

const resourceOne: ResourceSummary = {
  id: 'res-1',
  title: 'Abalone stock health in southern waters',
  summary: 'An overview of abalone population trends and stressors.',
  type: 'pdf',
  topicIds: ['stock-assessment'],
  keyFacts: ['Populations have declined 12% since 2019.'],
  published: '2023-06-01',
}

const resourceTwo: ResourceSummary = {
  id: 'res-2',
  title: 'Marine heatwave impacts on rock lobster',
  summary: 'Field study of thermal stress on rock lobster fisheries.',
  type: 'web',
  topicIds: ['marine-sustainability'],
  keyFacts: ['Heatwave events correlate with reduced catch rates.'],
}

class StubProvider implements RetrievalProvider {
  private resources: ResourceSummary[] = [resourceOne, resourceTwo]

  async listResources(_tenant: TenantConfig): Promise<ResourceSummary[]> {
    return this.resources
  }

  async resource(_tenant: TenantConfig, id: string): Promise<ResourceSummary | null> {
    return this.resources.find((resource) => resource.id === id) ?? null
  }

  async search(_tenant: TenantConfig, query: string): Promise<SearchResults> {
    return {
      query,
      resources: this.resources.map((resource, index) => ({
        ...resource,
        relevance: index === 0 ? 0.9 : 0.6,
        citedCount: 0,
      })),
      relatedQuestions: [{ id: 'rq-1', text: 'What else affects this species?' }],
    }
  }

  async catalog(_tenant: TenantConfig): Promise<CatalogPage> {
    return {
      items: this.resources.map((r) => ({
        id: r.id,
        title: r.title,
        status: 'processed' as const,
        topicIds: r.topicIds,
      })),
      total: this.resources.length,
    }
  }

  async facets(_tenant: TenantConfig, labelsets: string[]): Promise<FacetCounts> {
    const first = labelsets[0]
    return first ? { [first]: { 'stock-assessment': 1 } } : {}
  }

  async labelsets(_tenant: TenantConfig): Promise<Labelset[]> {
    return [{ id: 'topic', title: 'Topic', multiple: false, labels: ['stock-assessment'] }]
  }

  async suggest(_tenant: TenantConfig): Promise<Question[]> {
    return [{ id: 'sq-1', text: 'What is known about abalone stock health?' }]
  }

  async *ask(_tenant: TenantConfig, query: string): AsyncIterable<AskEvent> {
    yield { type: 'stage', stage: 'preprocessing', status: 'started' }
    yield { type: 'stage', stage: 'preprocessing', status: 'completed' }
    yield {
      type: 'sources',
      resources: [{ ...resourceOne, relevance: 0.9, citedCount: 1 }],
    }
    yield { type: 'delta', text: `Here is what we know about ${query}.` }
    yield {
      type: 'citation',
      citation: { index: 1, resourceId: resourceOne.id, title: resourceOne.title },
    }
    yield { type: 'done' }
  }
}

function makeApp() {
  return buildApp({ provider: new StubProvider(), tenants: freshTenants() })
}

describe('GET /api/tenants', () => {
  it('returns both tenants with expected slugs', async () => {
    const app = makeApp()
    const response = await app.request('/api/tenants')

    expect(response.status).toBe(200)
    const body = await response.json() as Array<{ slug: string }>
    const slugs = body.map((tenant) => tenant.slug)
    expect(slugs).toContain('grdc')
    expect(slugs).toContain('frdc')
  })
})

describe('GET /api/t/:slug/config', () => {
  it('parses with TenantConfigSchema for a known tenant', async () => {
    const app = makeApp()
    const response = await app.request('/api/t/grdc/config')

    expect(response.status).toBe(200)
    TenantConfigSchema.parse(await response.json())
  })

  it('returns 404 for an unknown tenant', async () => {
    const app = makeApp()
    const response = await app.request('/api/t/nope/config')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'unknown_tenant' })
  })
})

describe('GET /api/t/:slug/search', () => {
  it('returns a SearchResultsSchema-valid payload', async () => {
    const app = makeApp()
    const response = await app.request('/api/t/frdc/search?q=abalone')

    expect(response.status).toBe(200)
    SearchResultsSchema.parse(await response.json())
  })

  it('returns 400 when q is missing', async () => {
    const app = makeApp()
    const response = await app.request('/api/t/frdc/search')

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'missing_query' })
  })
})

describe('POST /api/t/:slug/ask', () => {
  it('streams SSE data lines that parse with AskEventSchema, including a done event', async () => {
    const app = makeApp()
    const response = await app.request('/api/t/frdc/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const payload = await response.text()
    const dataLines = payload
      .split('\n\n')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => chunk.slice('data: '.length))

    expect(dataLines.length).toBeGreaterThan(0)

    const events = dataLines.map((line) => AskEventSchema.parse(JSON.parse(line)))
    expect(events.some((event) => event.type === 'done')).toBe(true)
  })
})

describe('admin', () => {
  const passcode = 'test-passcode'

  it('disables the admin surface entirely when no passcode is configured', async () => {
    const app = buildApp({ provider: new StubProvider(), tenants: freshTenants() })
    const response = await app.request('/api/admin/overview')
    expect(response.status).toBe(503)
  })

  it('rejects admin calls without the passcode', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      adminPasscode: passcode,
    })
    const response = await app.request('/api/admin/overview')

    expect(response.status).toBe(401)
  })

  it('returns a schema-valid overview with the passcode', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      adminPasscode: passcode,
    })
    const response = await app.request('/api/admin/overview', {
      headers: { 'x-admin-passcode': passcode },
    })

    expect(response.status).toBe(200)
    const rows = (await response.json()) as unknown[]
    expect(rows.length).toBe(2)
    for (const row of rows) AdminTenantOverviewSchema.parse(row)
  })

  it('reverting a connected binding falls back to the demo box', async () => {
    const dir = Deno.makeTempDirSync()
    const bindings = new BindingStore({
      BINDINGS_PATH: `${dir}/bindings.json`,
      ARAG_ZONE: 'aws-ap-southeast-2-1',
      ARAG_KB_FRDC: 'demo-kb-id-000000',
      ARAG_KB_FRDC_TOKEN: 'demo-token-00000000000000',
    })
    bindings.set('frdc', {
      baseUrl: 'https://zone.rag.progress.cloud/api/v1/kb/connected-kb-111111',
      token: 'connected-token-1111111111',
      kbId: 'connected-kb-111111',
    })
    expect(bindings.status('frdc').status).toBe('connected')

    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      bindings,
      adminPasscode: passcode,
    })
    const response = await app.request('/api/admin/t/frdc/knowledge-box', {
      method: 'DELETE',
      headers: { 'x-admin-passcode': passcode },
    })

    expect(response.status).toBe(200)
    expect(bindings.status('frdc').status).toBe('demo')
  })
})
