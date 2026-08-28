import process from 'node:process'
import { join } from 'node:path'
import {
  type CatalogItem,
  type CatalogPage,
  DEFAULT_RESEARCH_ENRICHMENT,
  type Enrichment,
  type EnrichmentAgent,
  enrichmentJsonSchema,
  type EnrichmentRunEvent,
  parseEnrichmentData,
  type ResourceContent,
  type ResourceSummary,
  type ScoredResource,
  type SearchResults,
  type TenantConfig,
} from '@research-portal/core'
import { overlayEnrichment } from '@research-portal/retrieval'
import type { AragProvider } from '@research-portal/retrieval'
import { readJsonSafe, writeJsonAtomic } from './persist.ts'

/**
 * The portal's own store of generated enrichments (the merchandising cache),
 * keyed by tenant + resource id. Generation is app-side and cached here rather
 * than written back to the knowledge box, because the platform's ingest-time
 * JSON DA generator is unavailable (the `generator` task type is not in the DA
 * task enum - verified live; see docs/ARAG-DEV.md). Enrichments are produced
 * with the query-time `/ask` `answer_json_schema` path scoped to one resource,
 * which is verified working. One JSON file per tenant, matching the other
 * volume-backed stores (insights, sessions, sources).
 */
function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown'
}

/** Persisted shape: schemaId -> resourceId -> Enrichment. */
type TenantEnrichments = Record<string, Record<string, Enrichment>>

export class EnrichmentStore {
  private cache = new Map<string, TenantEnrichments>()
  private readonly dataDir: string

  /** `dataDir` defaults to $DATA_DIR (or ./data); overridable for tests. */
  constructor(dataDir: string = process.env.DATA_DIR ?? './data') {
    this.dataDir = dataDir
  }

  private pathFor(slug: string): string {
    return join(this.dataDir, 'enrichments', `${safeSegment(slug)}.json`)
  }

  private load(slug: string): TenantEnrichments {
    const cached = this.cache.get(slug)
    if (cached) return cached
    const data = readJsonSafe<TenantEnrichments>(this.pathFor(slug), {})
    this.cache.set(slug, data)
    return data
  }

  /** The enrichment for one resource under one agent (default agent when omitted). */
  get(
    slug: string,
    resourceId: string,
    schemaId = DEFAULT_RESEARCH_ENRICHMENT.id,
  ): Enrichment | undefined {
    return this.load(slug)[schemaId]?.[resourceId]
  }

  /** A resource-id -> enrichment map for the default agent (used by overlays). */
  forAgent(slug: string, schemaId = DEFAULT_RESEARCH_ENRICHMENT.id): Record<string, Enrichment> {
    return this.load(slug)[schemaId] ?? {}
  }

  put(slug: string, resourceId: string, enrichment: Enrichment): void {
    const data = this.load(slug)
    const bucket = data[enrichment.schemaId] ?? (data[enrichment.schemaId] = {})
    bucket[resourceId] = enrichment
    writeJsonAtomic(this.pathFor(slug), data)
  }

  /** How many resources carry an enrichment for this agent. */
  count(slug: string, schemaId = DEFAULT_RESEARCH_ENRICHMENT.id): number {
    return Object.keys(this.load(slug)[schemaId] ?? {}).length
  }
}

// ---------------------------------------------------------------------------
// Overlays: apply cached enrichments to provider results before they leave the
// API, so every user-facing surface merchandises from the same source. The
// provider already produced a baseline (cleaned fallback title + source name);
// here the generated title/summary/takeaways/quotes win when present.
// ---------------------------------------------------------------------------

function overlay(
  base: { title: string; summary?: string; sourceName?: string; enriched?: boolean },
  enrichment: Enrichment | undefined,
) {
  return overlayEnrichment({
    title: base.title,
    summary: base.summary ?? base.title,
    ...(base.sourceName ? { sourceName: base.sourceName } : {}),
    enriched: base.enriched ?? false,
  }, enrichment)
}

export function merchandiseSummary(
  store: EnrichmentStore,
  slug: string,
  resource: ResourceSummary,
): ResourceSummary {
  const m = overlay(resource, store.get(slug, resource.id))
  return {
    ...resource,
    title: m.title,
    summary: m.summary,
    ...(m.sourceName ? { sourceName: m.sourceName } : {}),
    ...(m.keyTakeaways ? { keyTakeaways: m.keyTakeaways } : {}),
    ...(m.quotesOfInterest ? { quotesOfInterest: m.quotesOfInterest } : {}),
    enriched: m.enriched,
  }
}

export function merchandiseSummaries(
  store: EnrichmentStore,
  slug: string,
  resources: ResourceSummary[],
): ResourceSummary[] {
  return resources.map((r) => merchandiseSummary(store, slug, r))
}

export function merchandiseScored(
  store: EnrichmentStore,
  slug: string,
  resource: ScoredResource,
): ScoredResource {
  return { ...resource, ...merchandiseSummary(store, slug, resource) }
}

export function merchandiseSearchResults(
  store: EnrichmentStore,
  slug: string,
  results: SearchResults,
): SearchResults {
  return { ...results, resources: results.resources.map((r) => merchandiseScored(store, slug, r)) }
}

export function merchandiseCatalogItem(
  store: EnrichmentStore,
  slug: string,
  item: CatalogItem,
): CatalogItem {
  const m = overlay({
    title: item.title,
    summary: item.summary,
    sourceName: item.sourceName,
    enriched: item.enriched,
  }, store.get(slug, item.id))
  return {
    ...item,
    title: m.title,
    summary: m.summary,
    ...(m.sourceName ? { sourceName: m.sourceName } : {}),
    enriched: m.enriched,
  }
}

export function merchandiseCatalogPage(
  store: EnrichmentStore,
  slug: string,
  page: CatalogPage,
): CatalogPage {
  return { ...page, items: page.items.map((i) => merchandiseCatalogItem(store, slug, i)) }
}

export function merchandiseContent(
  store: EnrichmentStore,
  slug: string,
  content: ResourceContent,
): ResourceContent {
  const m = overlay({
    title: content.title,
    summary: content.summary,
    sourceName: content.sourceName,
    enriched: content.enriched,
  }, store.get(slug, content.id))
  return {
    ...content,
    title: m.title,
    summary: m.summary,
    ...(m.sourceName ? { sourceName: m.sourceName } : {}),
    ...(m.keyTakeaways ? { keyTakeaways: m.keyTakeaways } : {}),
    ...(m.quotesOfInterest ? { quotesOfInterest: m.quotesOfInterest } : {}),
    enriched: m.enriched,
  }
}

// ---------------------------------------------------------------------------
// Generation: app-side, one resource at a time, via the verified query-time
// answer_json_schema path scoped to that resource. The platform DA
// page-summary is reused as the summary source when present (work already paid
// for at ingest), so the generator focuses on the richer fields.
// ---------------------------------------------------------------------------

/** Build the generator instruction from the agent's field descriptors (programmatic). */
export function buildEnrichmentQuery(agent: EnrichmentAgent): string {
  const fields = agent.fields.map((f) => `${f.label}: ${f.description}`).join(' ')
  return (
    'You are writing a catalogue entry for a SINGLE research document, using only this document. ' +
    `Produce these fields. ${fields} ` +
    'Base everything strictly on the document; do not invent. Australian English.'
  )
}

export async function generateEnrichment(
  management: AragProvider,
  config: TenantConfig,
  resourceId: string,
  agent: EnrichmentAgent = DEFAULT_RESEARCH_ENRICHMENT,
): Promise<Enrichment> {
  // Read the resource first so we can reuse the DA page-summary for the
  // summary field rather than paying to regenerate it.
  const content = await management.resourceContent(config, resourceId).catch(() => null)
  const pageSummary = content?.pageSummary?.trim()

  const schema = enrichmentJsonSchema(agent)
  const result = await management.askStructured(config, schema, buildEnrichmentQuery(agent), {
    resourceId,
  })
  const data = parseEnrichmentData(agent, result.object)

  // Prefer the platform's already-generated page summary for the summary field
  // when it exists and is substantial - cheaper, and a real per-resource
  // summary paid for at ingest.
  let usedPageSummary = false
  const summaryField = agent.fields.find((f) => f.kind === 'summary')
  if (summaryField && pageSummary && pageSummary.length >= 40) {
    data[summaryField.key] = pageSummary
    usedPageSummary = true
  }

  return {
    schemaId: agent.id,
    generatedAt: new Date().toISOString(),
    data,
    ...(usedPageSummary ? { usedPageSummary: true } : {}),
  }
}

/** Concurrency for corpus runs - bounded so a run never hammers the ARAG account. */
const RUN_CONCURRENCY = 4

/**
 * Run an enrichment agent over the corpus, streaming progress as each resource
 * completes. `scope: 'missing'` only enriches resources without an enrichment
 * yet; `'all'` regenerates everything. Bounded concurrency keeps the account
 * safe. Never blocks a hot path - this is an admin operation. Items complete
 * out of order (concurrent), so progress is by count, not sequence.
 */
export async function* runEnrichmentOverCorpus(
  management: AragProvider,
  store: EnrichmentStore,
  config: TenantConfig,
  opts: { scope: 'all' | 'missing'; limit?: number; agent?: EnrichmentAgent },
): AsyncGenerator<EnrichmentRunEvent> {
  const agent = opts.agent ?? DEFAULT_RESEARCH_ENRICHMENT
  const titleKey = agent.fields.find((f) => f.kind === 'title')?.key
  let catalogue: ResourceSummary[]
  try {
    catalogue = await management.listResources(config)
  } catch (err) {
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : 'Could not list resources',
    }
    return
  }
  const targets = opts.scope === 'all'
    ? catalogue
    : catalogue.filter((r) => !store.get(config.slug, r.id, agent.id))
  const limited = typeof opts.limit === 'number' ? targets.slice(0, opts.limit) : targets

  yield { type: 'start', total: limited.length }
  if (limited.length === 0) {
    yield { type: 'done', enriched: 0, errors: 0 }
    return
  }

  // Producer/consumer channel: a bounded pool of workers pushes an event per
  // completed resource; this generator drains the channel and yields.
  const channel: EnrichmentRunEvent[] = []
  let notify: (() => void) | null = null
  const wake = () => {
    notify?.()
    notify = null
  }
  const push = (event: EnrichmentRunEvent) => {
    channel.push(event)
    wake()
  }

  let index = 0
  let enriched = 0
  let errors = 0
  const worker = async () => {
    for (;;) {
      const i = index++
      if (i >= limited.length) return
      const resource = limited[i]!
      try {
        const enrichment = await generateEnrichment(management, config, resource.id, agent)
        store.put(config.slug, resource.id, enrichment)
        enriched++
        const generatedTitle = titleKey && typeof enrichment.data[titleKey] === 'string'
          ? String(enrichment.data[titleKey])
          : ''
        push({
          type: 'item',
          id: resource.id,
          title: generatedTitle || resource.title,
          outcome: 'enriched',
        })
      } catch (err) {
        errors++
        push({
          type: 'item',
          id: resource.id,
          title: resource.title,
          outcome: 'error',
          detail: err instanceof Error ? err.message.slice(0, 140) : 'generation failed',
        })
      }
    }
  }

  const pool = Promise.all(
    Array.from({ length: Math.min(RUN_CONCURRENCY, limited.length) }, worker),
  )
  let finished = false
  pool.then(() => {
    finished = true
    wake()
  })

  let emitted = 0
  while (emitted < limited.length) {
    if (channel.length > emitted) {
      yield channel[emitted]!
      emitted++
      continue
    }
    if (finished) break
    await new Promise<void>((resolve) => {
      notify = resolve
    })
  }
  await pool
  yield { type: 'done', enriched, errors }
}
