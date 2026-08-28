import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type {
  Enrichment,
  EnrichmentRunEvent,
  ResourceSummary,
  ScoredResource,
  TenantConfig,
} from '@research-portal/core'
import { DEFAULT_RESEARCH_ENRICHMENT } from '@research-portal/core'
import { AragProvider } from '@research-portal/retrieval'
import {
  buildEnrichmentQuery,
  EnrichmentStore,
  generateEnrichment,
  merchandiseScored,
  merchandiseSummary,
  runEnrichmentOverCorpus,
} from './enrichments.ts'

/**
 * The enrichment store, the merchandising overlays, and app-side generation
 * (the query-time answer_json_schema path that sidesteps the unavailable
 * ingest-time JSON DA generator), driven by fetch doubles.
 */

const tmp = () => Deno.makeTempDirSync()

const baseSummary = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  id: 'r1',
  title: 'Project 1981-071',
  summary: 'Project 1981-071',
  type: 'document',
  topicIds: [],
  keyFacts: [],
  sourceName: '1981-071-DLD.pdf',
  enriched: false,
  ...over,
})

const enrichment = (): Enrichment => ({
  schemaId: DEFAULT_RESEARCH_ENRICHMENT.id,
  generatedAt: '2026-08-28T00:00:00.000Z',
  data: {
    title: 'Echo-sounder and radar training for professional fishers',
    summary: 'A 1985 NSW Department of Agriculture course program.',
    keyTakeaways: ['Covers echosounders, sonar, radar and radio'],
    quotesOfInterest: ['"Participants receive financial assistance"'],
  },
})

describe('EnrichmentStore', () => {
  it('persists and reads back an enrichment keyed by tenant + resource', () => {
    const store = new EnrichmentStore(tmp())
    store.put('frdc-2', 'r1', enrichment())
    expect(store.get('frdc-2', 'r1')?.data.title).toContain('Echo-sounder')
    expect(store.count('frdc-2')).toBe(1)
    expect(store.get('frdc-2', 'missing')).toBeUndefined()
  })

  it('survives a fresh instance over the same directory (durable)', () => {
    const dir = tmp()
    new EnrichmentStore(dir).put('frdc-2', 'r1', enrichment())
    expect(new EnrichmentStore(dir).get('frdc-2', 'r1')?.data.title).toContain('Echo-sounder')
  })
})

describe('merchandising overlays', () => {
  it('leaves the baseline title (fallback) when no enrichment is stored', () => {
    const store = new EnrichmentStore(tmp())
    const out = merchandiseSummary(store, 'frdc-2', baseSummary())
    expect(out.title).toBe('Project 1981-071')
    expect(out.enriched).toBe(false)
    expect(out.sourceName).toBe('1981-071-DLD.pdf')
  })

  it('overlays the generated title/summary/takeaways/quotes when present', () => {
    const store = new EnrichmentStore(tmp())
    store.put('frdc-2', 'r1', enrichment())
    const out = merchandiseSummary(store, 'frdc-2', baseSummary())
    expect(out.title).toBe('Echo-sounder and radar training for professional fishers')
    expect(out.summary).toContain('1985 NSW Department of Agriculture')
    expect(out.keyTakeaways?.length).toBe(1)
    expect(out.quotesOfInterest?.length).toBe(1)
    expect(out.enriched).toBe(true)
    // Raw filename is retained as muted secondary, never the headline.
    expect(out.sourceName).toBe('1981-071-DLD.pdf')
  })

  it('overlays a scored search result the same way', () => {
    const store = new EnrichmentStore(tmp())
    store.put('frdc-2', 'r1', enrichment())
    const scored: ScoredResource = { ...baseSummary(), relevance: 0.8, citedCount: 0 }
    const out = merchandiseScored(store, 'frdc-2', scored)
    expect(out.title).toBe('Echo-sounder and radar training for professional fishers')
    expect(out.relevance).toBe(0.8)
  })
})

describe('buildEnrichmentQuery', () => {
  it('names every field of the agent (programmatic, not hardcoded)', () => {
    const q = buildEnrichmentQuery(DEFAULT_RESEARCH_ENRICHMENT)
    for (const field of DEFAULT_RESEARCH_ENRICHMENT.fields) {
      expect(q).toContain(field.label)
    }
    expect(q).toContain('SINGLE research document')
  })
})

// --- Generation via fetch doubles -----------------------------------------

const KB = 'https://test.rag.progress.cloud/api/v1/kb/test-kb'

function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * A management double: /catalog lists two resources, each /resource carries a
 * DA page-summary field, /ask returns a structured answer_json object. `answer`
 * overrides the generated object; `pageSummary` seeds the DA field.
 */
function management(
  opts: { answer?: Record<string, unknown>; pageSummary?: string; askShouldFail?: boolean } = {},
): AragProvider {
  const pageSummary = opts.pageSummary ??
    'This document outlines a series of courses for professional fishers in 1985.'
  const answer = opts.answer ?? {
    title: 'Echo-sounder and radar training for professional fishers',
    summary: '', // force the page-summary reuse path
    keyTakeaways: ['Covers echosounders, sonar, radar and radio'],
    quotesOfInterest: [],
  }
  return new AragProvider({
    resolveBinding: (slug) => slug === 'frdc-2' ? { baseUrl: KB, token: 't' } : undefined,
    fetchImpl: (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/catalog')) {
        return Promise.resolve(json({
          resources: {
            r1: { title: '1981-071-DLD.pdf', metadata: { status: 'PROCESSED' } },
            r2: { title: '1984-065-DLD.pdf', metadata: { status: 'PROCESSED' } },
          },
        }))
      }
      if (url.includes('/resource/')) {
        return Promise.resolve(json({
          title: '1981-071-DLD.pdf',
          data: {
            texts: {
              'da-pagesummary-f-file': { extracted: { text: { text: pageSummary } } },
            },
          },
        }))
      }
      if (url.endsWith('/ask')) {
        if (opts.askShouldFail) return Promise.resolve(new Response('boom', { status: 500 }))
        return Promise.resolve(ndjson([
          { item: { type: 'retrieval', results: { resources: {} } } },
          { item: { type: 'answer_json', object: answer } },
        ]))
      }
      throw new Error(`unexpected fetch ${url}`)
    },
  })
}

const config = {
  slug: 'frdc-2',
  branding: {
    productName: 'P',
    organisation: 'O',
    tagline: 't',
    colours: { primary: '#000', accent: '#000', heroFrom: '#000', heroTo: '#000' },
  },
  searchPlaceholder: '',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
} satisfies TenantConfig

describe('generateEnrichment', () => {
  it('produces schema-conformant data and reuses the DA page summary for the summary field', async () => {
    const e = await generateEnrichment(management(), config, 'r1')
    expect(e.schemaId).toBe(DEFAULT_RESEARCH_ENRICHMENT.id)
    expect(e.data.title).toContain('Echo-sounder')
    // The generator returned an empty summary; the DA page summary filled it.
    expect(e.data.summary).toContain('courses for professional fishers')
    expect(e.usedPageSummary).toBe(true)
  })

  it('prefers the platform DA page summary even over a generated summary (cheaper, already paid for)', async () => {
    const e = await generateEnrichment(
      management({
        answer: {
          title: 'A real title',
          summary: 'A full generated summary of at least forty characters in length here.',
          keyTakeaways: [],
          quotesOfInterest: [],
        },
      }),
      config,
      'r1',
    )
    expect(e.data.summary).toContain('courses for professional fishers')
    expect(e.usedPageSummary).toBe(true)
  })

  it('falls back to the generated summary when no DA page summary exists', async () => {
    const e = await generateEnrichment(
      management({
        pageSummary: '', // no DA page summary on this resource
        answer: {
          title: 'A real title',
          summary: 'A full generated summary of at least forty characters in length here.',
          keyTakeaways: [],
          quotesOfInterest: [],
        },
      }),
      config,
      'r1',
    )
    expect(e.data.summary).toContain('full generated summary')
    expect(e.usedPageSummary).toBeUndefined()
  })
})

describe('runEnrichmentOverCorpus', () => {
  async function collect(gen: AsyncGenerator<EnrichmentRunEvent>): Promise<EnrichmentRunEvent[]> {
    const out: EnrichmentRunEvent[] = []
    for await (const e of gen) out.push(e)
    return out
  }

  it('streams start -> item(s) -> done and stores each enrichment', async () => {
    const store = new EnrichmentStore(tmp())
    const events = await collect(
      runEnrichmentOverCorpus(management(), store, config, { scope: 'missing' }),
    )
    expect(events[0]).toEqual({ type: 'start', total: 2 })
    const done = events.at(-1)
    expect(done?.type).toBe('done')
    if (done?.type === 'done') {
      expect(done.enriched).toBe(2)
      expect(done.errors).toBe(0)
    }
    expect(store.count('frdc-2')).toBe(2)
    // Item events carry the generated title, not the filename.
    const items = events.filter((e) => e.type === 'item')
    expect(items.every((i) => i.type === 'item' && i.outcome === 'enriched')).toBe(true)
  })

  it('scope "missing" skips resources already enriched', async () => {
    const store = new EnrichmentStore(tmp())
    store.put('frdc-2', 'r1', enrichment())
    const events = await collect(
      runEnrichmentOverCorpus(management(), store, config, { scope: 'missing' }),
    )
    expect(events[0]).toEqual({ type: 'start', total: 1 })
  })

  it('reports per-item errors without aborting the run', async () => {
    const store = new EnrichmentStore(tmp())
    const events = await collect(
      runEnrichmentOverCorpus(management({ askShouldFail: true }), store, config, { scope: 'all' }),
    )
    const done = events.at(-1)
    if (done?.type === 'done') {
      expect(done.errors).toBe(2)
      expect(done.enriched).toBe(0)
    }
  })
})
