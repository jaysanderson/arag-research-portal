import type {
  AskEvent,
  Citation,
  Question,
  ResourceSummary,
  ResourceType,
  ScoredResource,
  SearchResults,
  TenantConfig,
} from '@research-portal/core'
import { ResourceSummarySchema } from '@research-portal/core'
import type { RetrievalProvider } from '../../provider.ts'
import { type KbBinding, KbClient, ndjson } from './client.ts'

const CATALOG_TTL_MS = 60_000

/** The extra.metadata payload the provisioning script stores on every resource. */
interface PortalMetadata {
  summary?: string
  keyFacts?: string[]
  topic?: string
  type?: string
  published?: string
}

interface RawResource {
  id?: string
  title?: string
  summary?: string
  created?: string
  usermetadata?: { classifications?: { labelset?: string; label?: string }[] }
  extra?: { metadata?: PortalMetadata }
  metadata?: { status?: string }
}

export interface AragProviderOptions {
  zone: string
  bindings: Record<string, KbBinding>
  fetchImpl?: typeof fetch
}

/**
 * RetrievalProvider backed by Progress Agentic RAG knowledge boxes - one KB
 * per tenant, bound by slug. Every answer, search result and resource comes
 * from the live regional API; nothing is fabricated here.
 */
export class AragProvider implements RetrievalProvider {
  private readonly clients = new Map<string, KbClient>()
  private readonly catalogCache = new Map<string, { at: number; resources: ResourceSummary[] }>()

  constructor(private readonly opts: AragProviderOptions) {}

  private client(tenant: TenantConfig): KbClient {
    const existing = this.clients.get(tenant.slug)
    if (existing) return existing
    const binding = this.opts.bindings[tenant.slug]
    if (!binding) {
      throw new Error(
        `No knowledge box bound for tenant '${tenant.slug}' - set ARAG_KB_${tenant.slug.toUpperCase()} and ARAG_KB_${tenant.slug.toUpperCase()}_TOKEN (run the provision script)`,
      )
    }
    const client = new KbClient(this.opts.zone, binding, this.opts.fetchImpl ?? fetch)
    this.clients.set(tenant.slug, client)
    return client
  }

  private toSummary(id: string, raw: RawResource): ResourceSummary {
    const meta = raw.extra?.metadata ?? {}
    const topicFromLabels = (raw.usermetadata?.classifications ?? [])
      .filter((c) => c.labelset === 'topic' && c.label)
      .map((c) => c.label as string)
    const type: ResourceType = ((): ResourceType => {
      const t = meta.type
      return t === 'video' || t === 'web' || t === 'pdf' ? t : 'document'
    })()
    return ResourceSummarySchema.parse({
      id,
      title: raw.title ?? id,
      summary: meta.summary ?? raw.summary ?? raw.title ?? id,
      type,
      topicIds: topicFromLabels.length > 0 ? topicFromLabels : meta.topic ? [meta.topic] : [],
      keyFacts: meta.keyFacts ?? [],
      published: meta.published,
    })
  }

  async listResources(tenant: TenantConfig): Promise<ResourceSummary[]> {
    const cached = this.catalogCache.get(tenant.slug)
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.resources
    const client = this.client(tenant)
    const catalog = await client.getJson<{ resources?: Record<string, RawResource> }>(
      '/catalog?page=0&size=100',
    )
    const ids = Object.keys(catalog.resources ?? {})
    const resources = await Promise.all(
      ids.map(async (id) => {
        const raw = await client.getJson<RawResource>(
          `/resource/${id}?show=basic&show=extra`,
        )
        return this.toSummary(id, raw)
      }),
    )
    resources.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
    this.catalogCache.set(tenant.slug, { at: Date.now(), resources })
    return resources
  }

  async resource(tenant: TenantConfig, id: string): Promise<ResourceSummary | null> {
    try {
      const raw = await this.client(tenant).getJson<RawResource>(
        `/resource/${id}?show=basic&show=extra`,
      )
      return this.toSummary(id, raw)
    } catch (err) {
      if (err instanceof Error && 'status' in err && (err as { status: number }).status === 404) {
        return null
      }
      throw err
    }
  }

  async suggest(tenant: TenantConfig): Promise<Question[]> {
    return tenant.suggestedQuestions
  }

  async search(tenant: TenantConfig, query: string): Promise<SearchResults> {
    const trimmed = query.trim()
    if (!trimmed) return { query, resources: [], relatedQuestions: [] }
    const client = this.client(tenant)
    const [found, all] = await Promise.all([
      client.postJson<{
        resources?: Record<
          string,
          RawResource & {
            fields?: Record<
              string,
              { paragraphs?: Record<string, { score?: number; text?: string }> }
            >
          }
        >
      }>('/find', {
        query: trimmed,
        features: ['keyword', 'semantic'],
        show: ['basic', 'extra'],
      }),
      this.listResources(tenant),
    ])
    const byId = new Map(all.map((r) => [r.id, r]))
    const entries = Object.entries(found.resources ?? {})
    const scored = entries.map(([id, raw]) => {
      let best = 0
      let passage: string | undefined
      for (const field of Object.values(raw.fields ?? {})) {
        for (const paragraph of Object.values(field.paragraphs ?? {})) {
          const score = paragraph.score ?? 0
          if (score >= best) {
            best = score
            passage = paragraph.text ?? passage
          }
        }
      }
      return { id, raw, best, passage }
    })
    const maxScore = Math.max(...scored.map((s) => s.best), 1e-9)
    const resources: ScoredResource[] = scored
      .sort((a, b) => b.best - a.best)
      .map(({ id, raw, best, passage }) => ({
        ...(byId.get(id) ?? this.toSummary(id, raw)),
        relevance: Math.max(0, Math.min(1, best / maxScore)),
        citedCount: 0,
        matchedPassage: passage,
      }))
    const lowered = trimmed.toLowerCase()
    const relatedQuestions = tenant.suggestedQuestions
      .filter((q) => q.text.toLowerCase() !== lowered)
      .slice(0, 4)
    return { query: trimmed, resources, relatedQuestions }
  }

  async *ask(tenant: TenantConfig, query: string): AsyncIterable<AskEvent> {
    const client = this.client(tenant)
    yield { type: 'stage', stage: 'preprocessing', status: 'started' }
    let sources: ScoredResource[] = []
    let sawAnswer = false
    let generating = false
    let citationIndex = 0
    const cited = new Map<string, Citation>()
    const catalogue = await this.listResources(tenant).catch(() => [] as ResourceSummary[])
    const byId = new Map(catalogue.map((r) => [r.id, r]))
    yield { type: 'stage', stage: 'preprocessing', status: 'completed' }
    yield { type: 'stage', stage: 'retrieval', status: 'started' }

    const toSources = (retrieved: Record<string, RawResource>): ScoredResource[] =>
      Object.entries(retrieved).map(([id, raw]) => ({
        ...(byId.get(id) ?? this.toSummary(id, raw)),
        relevance: 1,
        citedCount: 0,
      }))

    const emitCitationsFor = (
      citations: Record<string, unknown>,
    ): Citation[] => {
      const fresh: Citation[] = []
      for (const key of Object.keys(citations)) {
        // Keys look like "<rid>/<field-type>/<field-id>/...". Skip DA-generated
        // fields - the platform can surface them as citation hits (known bug).
        if (key.includes('/da-')) continue
        const resourceId = key.split('/')[0]
        if (!resourceId || cited.has(resourceId)) continue
        citationIndex += 1
        const known = byId.get(resourceId) ?? sources.find((s) => s.id === resourceId)
        const citation: Citation = {
          index: citationIndex,
          resourceId,
          title: known?.title ?? resourceId,
        }
        cited.set(resourceId, citation)
        fresh.push(citation)
      }
      return fresh
    }

    try {
      const res = await client.postStream('/ask', {
        query,
        features: ['keyword', 'semantic'],
        citations: true,
        show: ['basic', 'origin'],
      })
      for await (const line of ndjson(res)) {
        const item = (line as { item?: { type?: string } & Record<string, unknown> }).item
        if (!item?.type) continue
        if (item.type === 'retrieval') {
          const results = item.results as { resources?: Record<string, RawResource> } | undefined
          sources = toSources(results?.resources ?? {})
          yield { type: 'sources', resources: sources }
          if (!generating) {
            generating = true
            yield { type: 'stage', stage: 'retrieval', status: 'completed' }
            yield { type: 'stage', stage: 'generating', status: 'started' }
          }
        } else if (item.type === 'answer' && typeof item.text === 'string') {
          if (!generating) {
            generating = true
            yield { type: 'stage', stage: 'retrieval', status: 'completed' }
            yield { type: 'stage', stage: 'generating', status: 'started' }
          }
          sawAnswer = true
          yield { type: 'delta', text: item.text }
        } else if (item.type === 'citations' && item.citations) {
          for (const citation of emitCitationsFor(item.citations as Record<string, unknown>)) {
            yield { type: 'citation', citation }
          }
        } else if (item.type === 'status' && typeof item.code === 'number' && item.code >= 400) {
          yield { type: 'error', message: `Answer service returned status ${item.code}` }
          return
        }
      }
      if (!sawAnswer) {
        // Streamed shape not recognised - fall back to a synchronous ask.
        const sync = await client.postJson<{
          answer?: string
          citations?: Record<string, unknown>
          retrieval_results?: { resources?: Record<string, RawResource> }
        }>(
          '/ask',
          { query, features: ['keyword', 'semantic'], citations: true, show: ['basic', 'origin'] },
          { 'x-synchronous': 'true' },
        )
        sources = toSources(sync.retrieval_results?.resources ?? {})
        yield { type: 'sources', resources: sources }
        if (!generating) {
          generating = true
          yield { type: 'stage', stage: 'retrieval', status: 'completed' }
          yield { type: 'stage', stage: 'generating', status: 'started' }
        }
        if (sync.answer) yield { type: 'delta', text: sync.answer }
        for (const citation of emitCitationsFor(sync.citations ?? {})) {
          yield { type: 'citation', citation }
        }
      }
      yield { type: 'stage', stage: 'generating', status: 'completed' }
      yield { type: 'stage', stage: 'validating', status: 'started' }
      yield { type: 'stage', stage: 'validating', status: 'completed' }
      yield { type: 'done' }
    } catch (err) {
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : 'The answer service is unavailable',
      }
    }
  }
}
