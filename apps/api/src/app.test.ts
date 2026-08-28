import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import {
  AdminTenantOverviewSchema,
  type AskEvent,
  AskEventSchema,
  type CatalogPage,
  DEFAULT_RESEARCH_ENRICHMENT,
  type Enrichment,
  type FacetCounts,
  type Labelset,
  type Question,
  type ResourceSummary,
  type SearchResults,
  SearchResultsSchema,
  type TenantConfig,
  TenantConfigSchema,
} from '@research-portal/core'
import { AragApiError, type RetrievalProvider } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { TenantStore } from './tenants.ts'
import { EnrichmentStore } from './enrichments.ts'

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

  async topicResources(_tenant: TenantConfig, topicId: string): Promise<ResourceSummary[]> {
    return this.resources.filter((resource) => resource.topicIds.includes(topicId))
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

function makeApp(enrichments?: EnrichmentStore) {
  return buildApp({ provider: new StubProvider(), tenants: freshTenants(), enrichments })
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

  it('BUG 1: merchandises sources and citations with the real generated title, never the raw filename/project-code title', async () => {
    // resourceOne's raw title stands in for a raw filename/project code
    // (e.g. "Project 1996-107") the way /search, /catalog and /resources
    // never show one when a real enrichment exists - /ask and /generate must
    // not diverge from that surface-wide rule.
    const enrichment: Enrichment = {
      schemaId: DEFAULT_RESEARCH_ENRICHMENT.id,
      generatedAt: '2026-08-28T00:00:00.000Z',
      data: {
        title: 'Distribution and Ecology of Southern Rock Lobster Larvae',
        summary: 'A study of larval distribution and ecology in southern rock lobster stocks.',
      },
    }
    const store = new EnrichmentStore(Deno.makeTempDirSync())
    store.put('frdc', resourceOne.id, enrichment)
    const app = makeApp(store)

    const response = await app.request('/api/t/frdc/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
    })
    expect(response.status).toBe(200)

    const payload = await response.text()
    const events = payload
      .split('\n\n')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => AskEventSchema.parse(JSON.parse(chunk.slice('data: '.length))))

    const sourcesEvent = events.find((e) => e.type === 'sources') as
      | { type: 'sources'; resources: { id: string; title: string }[] }
      | undefined
    const citationEvent = events.find((e) => e.type === 'citation') as
      | { type: 'citation'; citation: { resourceId: string; title: string } }
      | undefined

    expect(sourcesEvent?.resources[0]?.title).toBe(
      'Distribution and Ecology of Southern Rock Lobster Larvae',
    )
    expect(sourcesEvent?.resources[0]?.title).not.toBe(resourceOne.title)
    expect(citationEvent?.citation.title).toBe(
      'Distribution and Ecology of Southern Rock Lobster Larvae',
    )
    expect(citationEvent?.citation.title).not.toBe(resourceOne.title)
  })

  it('falls back to the baseline title when no enrichment exists for the cited resource', async () => {
    const app = makeApp(new EnrichmentStore(Deno.makeTempDirSync()))
    const response = await app.request('/api/t/frdc/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
    })
    const payload = await response.text()
    const events = payload
      .split('\n\n')
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.startsWith('data: '))
      .map((chunk) => AskEventSchema.parse(JSON.parse(chunk.slice('data: '.length))))
    const sourcesEvent = events.find((e) => e.type === 'sources') as
      | { type: 'sources'; resources: { title: string }[] }
      | undefined
    expect(sourcesEvent?.resources[0]?.title).toBe(resourceOne.title)
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

describe('GET /api/health', () => {
  it('returns 200 with ok:true and web:true when the SPA bundle exists', async () => {
    const dir = Deno.makeTempDirSync()
    Deno.writeTextFileSync(`${dir}/index.html`, '<!doctype html>')
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      webDistPath: dir,
    })

    const response = await app.request('/api/health')

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.web).toBe(true)
    expect(typeof body.version).toBe('string')
  })

  it('returns 503 when the SPA bundle is missing - a bundle-less image fails its health check', async () => {
    const dir = Deno.makeTempDirSync()
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      webDistPath: dir,
    })

    const response = await app.request('/api/health')

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.web).toBe(false)
  })

  it('requires no authentication', async () => {
    const dir = Deno.makeTempDirSync()
    Deno.writeTextFileSync(`${dir}/index.html`, '<!doctype html>')
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      adminPasscode: 'test-passcode',
      webDistPath: dir,
    })

    const response = await app.request('/api/health')

    expect(response.status).toBe(200)
  })
})

describe('GET /api/admin-prefill', () => {
  it('no longer exists - the passcode-prefill endpoint has been removed', async () => {
    const app = makeApp()
    const response = await app.request('/api/admin-prefill')
    expect(response.status).toBe(404)
  })
})

describe('security headers', () => {
  it('sets baseline security headers on every response', async () => {
    const app = makeApp()
    const response = await app.request('/api/tenants')

    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=63072000; includeSubDomains',
    )
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'")
  })
})

describe('POST /api/ask-estate', () => {
  it('scrubs upstream error detail (URL, knowledge-box id, response body) from anonymous callers', async () => {
    class FailingProvider extends StubProvider {
      override ask(): AsyncIterable<AskEvent> {
        throw new AragApiError(
          500,
          'https://zone.rag.progress.cloud/api/v1/kb/secret-kb-id-111111',
          'super secret upstream response body',
        )
      }
    }

    const app = buildApp({ provider: new FailingProvider(), tenants: freshTenants() })
    const response = await app.request('/api/ask-estate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
    })

    expect(response.status).toBe(200)
    const payload = await response.text()

    expect(payload).not.toContain('secret-kb-id')
    expect(payload).not.toContain('super secret upstream response body')
    expect(payload).not.toContain('zone.rag.progress.cloud')
    expect(payload).toContain('had a problem (HTTP 500)')
  })
})

describe('rate limiting on anonymous LLM-spend routes', () => {
  it('429s an EXPENSIVE route (ask) after the configured per-IP limit, with Retry-After', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      rateLimitAskPerMin: 2,
    })
    const ask = () =>
      app.request('/api/t/frdc/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'fly-client-ip': '203.0.113.5' },
        body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
      })

    expect((await ask()).status).toBe(200)
    expect((await ask()).status).toBe(200)
    const third = await ask()

    expect(third.status).toBe(429)
    expect(await third.json()).toEqual({ error: 'rate_limited' })
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('isolates the limit per client IP - a different caller is unaffected', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      rateLimitAskPerMin: 1,
    })
    const askAs = (ip: string) =>
      app.request('/api/t/frdc/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'fly-client-ip': ip },
        body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
      })

    expect((await askAs('203.0.113.1')).status).toBe(200)
    expect((await askAs('203.0.113.1')).status).toBe(429)
    expect((await askAs('203.0.113.2')).status).toBe(200)
  })

  it('applies the ESTATE tier (not the EXPENSIVE tier) to POST /api/ask-estate', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      rateLimitAskPerMin: 20,
      rateLimitEstatePerMin: 1,
    })
    const askEstate = () =>
      app.request('/api/ask-estate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'fly-client-ip': '203.0.113.9' },
        body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
      })

    expect((await askEstate()).status).toBe(200)
    const second = await askEstate()
    expect(second.status).toBe(429)
  })

  it('0 disables the EXPENSIVE tier entirely', async () => {
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      rateLimitAskPerMin: 0,
    })
    const ask = () =>
      app.request('/api/t/frdc/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'fly-client-ip': '203.0.113.5' },
        body: JSON.stringify({ query: 'What is known about abalone stock health?' }),
      })

    for (let i = 0; i < 25; i++) {
      expect((await ask()).status).toBe(200)
    }
  })

  it('never rate-limits admin routes, even past the EXPENSIVE per-IP limit', async () => {
    const passcode = 'test-passcode'
    const app = buildApp({
      provider: new StubProvider(),
      tenants: freshTenants(),
      adminPasscode: passcode,
      rateLimitAskPerMin: 1,
    })
    const headers = { 'x-admin-passcode': passcode, 'fly-client-ip': '203.0.113.5' }

    for (let i = 0; i < 5; i++) {
      const response = await app.request('/api/admin/overview', { headers })
      expect(response.status).toBe(200)
    }
  })
})
