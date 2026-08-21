import type {
  AskEvent,
  CatalogItem,
  CatalogPage,
  Citation,
  FacetCounts,
  GraphData,
  KbCounters,
  Labelset,
  Question,
  RecentResource,
  ResourceSummary,
  ResourceType,
  ScoredResource,
  SearchResults,
  TenantConfig,
} from '@research-portal/core'
import { ResourceSummarySchema } from '@research-portal/core'
import type {
  AskOptions,
  CatalogOptions,
  RetrievalProvider,
  SearchOptions,
} from '../../provider.ts'
import { AragApiError, type KbBinding, KbClient, ndjson } from './client.ts'

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

export class KnowledgeBoxNotConnectedError extends Error {
  constructor(readonly slug: string) {
    super(`No knowledge box connected for tenant '${slug}'`)
    this.name = 'KnowledgeBoxNotConnectedError'
  }
}

export interface AragProviderOptions {
  /** Resolve the current binding for a tenant slug - called per request so bindings can change at runtime. */
  resolveBinding: (slug: string) => KbBinding | undefined
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
    const binding = this.opts.resolveBinding(tenant.slug)
    if (!binding) {
      this.invalidate(tenant.slug)
      throw new KnowledgeBoxNotConnectedError(tenant.slug)
    }
    const key = `${tenant.slug}:${binding.baseUrl}`
    const existing = this.clients.get(key)
    if (existing) return existing
    // A new binding for this slug invalidates anything cached for the old one.
    this.invalidate(tenant.slug)
    const client = new KbClient(binding, this.opts.fetchImpl ?? fetch)
    this.clients.set(key, client)
    return client
  }

  /** Drop cached clients and catalogue entries for a tenant (call after rebinding). */
  invalidate(slug: string): void {
    for (const key of this.clients.keys()) {
      if (key.startsWith(`${slug}:`)) this.clients.delete(key)
    }
    this.catalogCache.delete(slug)
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
      title: raw.title || id,
      // Platform fields can be empty strings, which ?? would keep - use ||.
      summary: meta.summary || raw.summary || raw.title || id,
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

  // -------------------------------------------------------------------------
  // Management operations (admin surfaces) - all live platform calls.
  // -------------------------------------------------------------------------

  async counters(tenant: TenantConfig): Promise<KbCounters> {
    const raw = await this.client(tenant).getJson<{
      resources?: number
      paragraphs?: number
      sentences?: number
      index_size?: number
    }>('/counters')
    return {
      resources: raw.resources ?? 0,
      paragraphs: raw.paragraphs ?? 0,
      sentences: raw.sentences ?? 0,
      indexMb: Math.round((raw.index_size ?? 0) / 1e6),
    }
  }

  async recentResources(tenant: TenantConfig, limit = 12): Promise<RecentResource[]> {
    const raw = await this.client(tenant).getJson<{
      resources?: Record<string, RawResource & { created?: string }>
    }>(`/catalog?page_number=0&page_size=${limit}&show=basic&sort_field=created&sort_order=desc`)
    return Object.entries(raw.resources ?? {}).map(([id, r]) => {
      const status = r.metadata?.status
      return {
        id,
        title: r.title ?? id,
        status: status === 'PROCESSED' ? 'processed' : status === 'ERROR' ? 'error' : 'pending',
        created: r.created,
      }
    })
  }

  async uploadFile(
    tenant: TenantConfig,
    input: { filename: string; contentType: string; bytes: Uint8Array },
  ): Promise<{ id: string }> {
    const res = (await this.client(tenant).postRaw(
      '/upload',
      input.bytes,
      input.contentType,
      input.filename,
    )) as { uuid?: string; resource?: string }
    this.invalidateCatalogue(tenant.slug)
    return { id: res.uuid ?? res.resource ?? '' }
  }

  async createLink(
    tenant: TenantConfig,
    input: { url: string; title?: string },
  ): Promise<{ id: string }> {
    const res = await this.client(tenant).postJson<{ uuid?: string }>('/resources', {
      title: input.title ?? input.url,
      icon: 'application/stf-link',
      origin: { url: input.url },
      links: { link: { uri: input.url } },
    })
    this.invalidateCatalogue(tenant.slug)
    return { id: res.uuid ?? '' }
  }

  async createText(
    tenant: TenantConfig,
    input: {
      title: string
      body: string
      format?: 'PLAIN' | 'MARKDOWN'
      slug?: string
      topicId?: string
      extraMetadata?: Record<string, unknown>
    },
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      title: input.title,
      icon: 'text/plain',
      texts: { body: { body: input.body, format: input.format ?? 'MARKDOWN' } },
    }
    if (input.slug) body.slug = input.slug
    if (input.topicId) {
      body.usermetadata = { classifications: [{ labelset: 'topic', label: input.topicId }] }
    }
    if (input.extraMetadata) body.extra = { metadata: input.extraMetadata }
    const res = await this.client(tenant).postJson<{ uuid?: string }>('/resources', body)
    this.invalidateCatalogue(tenant.slug)
    return { id: res.uuid ?? '' }
  }

  /** Full resource read for migration - extracted text per field, labels, origin. */
  async resourceFull(tenant: TenantConfig, id: string): Promise<{
    title: string
    slug?: string
    kind: 'text' | 'link' | 'file'
    originUrl?: string
    texts: { fieldId: string; body: string }[]
    topicIds: string[]
    extraMetadata?: Record<string, unknown>
  }> {
    const raw = await this.client(tenant).getJson<
      RawResource & {
        slug?: string
        origin?: { url?: string }
        data?: {
          texts?: Record<
            string,
            { value?: { body?: string }; extracted?: { text?: { text?: string } } }
          >
          links?: Record<string, { extracted?: { text?: { text?: string } } }>
          files?: Record<string, unknown>
        }
      }
    >(
      `/resource/${id}?show=basic&show=origin&show=values&show=extracted&show=extra&extracted=text&extracted=metadata`,
    )
    const texts: { fieldId: string; body: string }[] = []
    for (const [fieldId, field] of Object.entries(raw.data?.texts ?? {})) {
      const body = field.value?.body ?? field.extracted?.text?.text
      if (body) texts.push({ fieldId, body })
    }
    for (const [fieldId, field] of Object.entries(raw.data?.links ?? {})) {
      const body = field.extracted?.text?.text
      if (body) texts.push({ fieldId: `link:${fieldId}`, body })
    }
    const hasFiles = Object.keys(raw.data?.files ?? {}).length > 0
    const kind = raw.origin?.url && Object.keys(raw.data?.links ?? {}).length > 0
      ? 'link'
      : hasFiles
      ? 'file'
      : 'text'
    const summary = this.toSummary(id, raw)
    return {
      title: summary.title,
      slug: raw.slug,
      kind,
      originUrl: raw.origin?.url,
      texts,
      topicIds: summary.topicIds,
      extraMetadata: raw.extra?.metadata as Record<string, unknown> | undefined,
    }
  }

  /** Whether a resource slug already exists in the tenant's knowledge box. */
  async hasSlug(tenant: TenantConfig, slug: string): Promise<boolean> {
    try {
      await this.client(tenant).getJson(`/slug/${slug}`)
      return true
    } catch {
      return false
    }
  }

  private invalidateCatalogue(slug: string): void {
    this.catalogCache.delete(slug)
  }

  async suggest(tenant: TenantConfig): Promise<Question[]> {
    return tenant.suggestedQuestions
  }

  async search(
    tenant: TenantConfig,
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchResults> {
    const trimmed = query.trim()
    if (!trimmed) return { query, resources: [], relatedQuestions: [] }
    const client = this.client(tenant)
    const mode = opts.mode ?? 'hybrid'
    const features = mode === 'hybrid' ? ['keyword', 'semantic'] : [mode]
    const body: Record<string, unknown> = {
      query: trimmed,
      features,
      page_size: opts.pageSize ?? 20,
      show: ['basic', 'origin'],
    }
    const filters = (opts.topicIds ?? []).map((t) => `/classification.labels/topic/${t}`)
    if (filters.length > 0) body.filters = filters
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
      }>('/find', body),
      this.listResources(tenant),
    ])
    const byId = new Map(all.map((r) => [r.id, r]))
    const entries = Object.entries(found.resources ?? {})
    // Relevance floor: below this a match is noise, and an off-corpus query
    // should say "no results" honestly rather than surface weak hits.
    const MIN_SCORE = 0.1
    const scored = entries
      .map(([id, raw]) => {
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
      .filter((s) => s.best >= MIN_SCORE)
    // Near-duplicate suppression: crawled pages repeat nav/footer chrome, so
    // two results opening with the same 120 characters are the same content.
    const seenSignatures = new Set<string>()
    const deduped = scored.sort((a, b) => b.best - a.best).filter((s) => {
      const signature = (s.passage ?? s.raw.title ?? s.id).slice(0, 120).toLowerCase()
      if (seenSignatures.has(signature)) return false
      seenSignatures.add(signature)
      return true
    })
    const maxScore = Math.max(...deduped.map((s) => s.best), 1e-9)
    const resources: ScoredResource[] = deduped.map(({ id, raw, best, passage }) => ({
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

  async catalog(tenant: TenantConfig, opts: CatalogOptions = {}): Promise<CatalogPage> {
    const params = new URLSearchParams()
    params.set('page_number', String(opts.page ?? 0))
    params.set('page_size', String(opts.pageSize ?? 24))
    params.append('show', 'basic')
    params.set('sort_field', opts.sortField ?? 'created')
    params.set('sort_order', opts.sortOrder ?? 'desc')
    if (opts.query) params.set('query', opts.query)
    for (const topic of opts.topicIds ?? []) {
      params.append('filters', `/classification.labels/topic/${topic}`)
    }
    const raw = await this.client(tenant).getJson<{
      resources?: Record<string, RawResource & { created?: string }>
      fulltext?: { total?: number }
      total?: number
    }>(`/catalog?${params.toString()}`)
    const items: CatalogItem[] = Object.entries(raw.resources ?? {}).map(([id, r]) => {
      const status = r.metadata?.status
      return {
        id,
        title: r.title ?? id,
        status: status === 'PROCESSED' ? 'processed' : status === 'ERROR' ? 'error' : 'pending',
        created: r.created,
        topicIds: (r.usermetadata?.classifications ?? [])
          .filter((c) => c.labelset === 'topic' && c.label)
          .map((c) => c.label as string),
      }
    })
    return { items, total: raw.fulltext?.total ?? raw.total ?? items.length }
  }

  async facets(
    tenant: TenantConfig,
    labelsets: string[],
    filters?: string[],
  ): Promise<FacetCounts> {
    if (labelsets.length === 0) return {}
    const params = new URLSearchParams({ page_size: '0' })
    for (const id of labelsets) params.append('faceted', `/classification.labels/${id}`)
    for (const f of filters ?? []) params.append('filters', f)
    const raw = await this.client(tenant).getJson<{
      fulltext?: { facets?: Record<string, Record<string, number>> }
      facets?: Record<string, Record<string, number>>
    }>(`/catalog?${params.toString()}`)
    const source = raw.fulltext?.facets ?? raw.facets ?? {}
    // The index can surface platform-computed classifications under the same
    // paths - keep only labels the labelset actually defines.
    const defined = new Map(
      (await this.labelsets(tenant)).map((ls) => [ls.id, new Set(ls.labels)]),
    )
    const out: FacetCounts = {}
    for (const [facetKey, counts] of Object.entries(source)) {
      const labelsetId = facetKey.split('/').pop() ?? facetKey
      const allowed = defined.get(labelsetId)
      const byLabel: Record<string, number> = {}
      for (const [labelPath, count] of Object.entries(counts)) {
        const label = labelPath.split('/').pop() ?? labelPath
        if (allowed && !allowed.has(label)) continue
        byLabel[label] = count
      }
      out[labelsetId] = byLabel
    }
    return out
  }

  async labelsets(tenant: TenantConfig): Promise<Labelset[]> {
    const raw = await this.client(tenant).getJson<{
      labelsets?: Record<
        string,
        { title?: string; multiple?: boolean; labels?: { title?: string }[] }
      >
    }>('/labelsets')
    return Object.entries(raw.labelsets ?? {}).map(([id, ls]) => ({
      id,
      title: ls.title ?? id,
      multiple: ls.multiple ?? true,
      labels: (ls.labels ?? []).map((l) => l.title ?? '').filter(Boolean),
    }))
  }

  /**
   * Label co-occurrence graph, the reference portal's model: primary labels
   * become weighted nodes; for each, the secondary facet counts WITHIN that
   * primary filter become edges. N+1 catalog calls, so primaries are capped.
   */
  async graphData(tenant: TenantConfig, primary: string, secondary: string): Promise<GraphData> {
    const primaryCounts = (await this.facets(tenant, [primary]))[primary] ?? {}
    const primaries = Object.entries(primaryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
    const nodes: GraphData['nodes'] = primaries.map(([label, weight]) => ({
      id: `${primary}:${label}`,
      label,
      group: 'primary',
      weight,
    }))
    const edges: GraphData['edges'] = []
    const secondaryTotals = new Map<string, number>()
    for (const [label] of primaries) {
      const within = await this.facets(
        tenant,
        [secondary],
        [`/classification.labels/${primary}/${label}`],
      )
      for (const [secLabel, count] of Object.entries(within[secondary] ?? {})) {
        if (count <= 0) continue
        edges.push({
          source: `${primary}:${label}`,
          target: `${secondary}:${secLabel}`,
          weight: count,
        })
        secondaryTotals.set(secLabel, (secondaryTotals.get(secLabel) ?? 0) + count)
      }
    }
    for (const [label, weight] of secondaryTotals) {
      nodes.push({ id: `${secondary}:${label}`, label, group: 'secondary', weight })
    }
    return { primary, secondary, nodes, edges }
  }

  /** Query-time structured generation. Citations must stay OFF here - the
   * platform 500s when citations and answer_json_schema are combined; sources
   * come from the retrieval event instead. */
  async askStructured(
    tenant: TenantConfig,
    schema: { name: string; description: string; parameters: unknown },
    query: string,
  ): Promise<{ object: unknown; sources: ResourceSummary[] }> {
    const client = this.client(tenant)
    const catalogue = await this.listResources(tenant).catch(() => [] as ResourceSummary[])
    const byId = new Map(catalogue.map((r) => [r.id, r]))
    const res = await client.postStream('/ask', {
      query,
      features: ['keyword', 'semantic'],
      answer_json_schema: schema,
      show: ['basic', 'origin'],
      // The default cap triggers 412 "Error generating json: max_tokens" on
      // large payloads like comparison matrices.
      max_tokens: 4096,
    })
    let object: unknown = null
    let sources: ResourceSummary[] = []
    for await (const line of ndjson(res)) {
      const item = (line as { item?: { type?: string } & Record<string, unknown> }).item
      if (!item?.type) continue
      if (item.type === 'retrieval') {
        const results = item.results as { resources?: Record<string, RawResource> } | undefined
        sources = Object.entries(results?.resources ?? {})
          .map(([id, raw]) => byId.get(id) ?? this.toSummary(id, raw))
          .slice(0, 12)
      } else if (item.type === 'answer_json' && item.object !== undefined) {
        object = item.object
      }
    }
    if (object === null) {
      throw new Error('The platform returned no structured answer - try a narrower request')
    }
    return { object, sources }
  }

  /** Replace a resource's classifications (used by corpus analysis). */
  async patchResourceClassifications(
    tenant: TenantConfig,
    resourceId: string,
    classifications: { labelset: string; label: string }[],
  ): Promise<void> {
    await this.client(tenant).patchJson(`/resource/${resourceId}`, {
      usermetadata: { classifications },
    })
    this.invalidateCatalogue(tenant.slug)
  }

  async createLabelset(
    tenant: TenantConfig,
    input: { id: string; title: string; multiple: boolean; labels: string[] },
  ): Promise<void> {
    await this.client(tenant).postJson(`/labelset/${input.id}`, {
      title: input.title,
      color: '#556b5f',
      multiple: input.multiple,
      kind: ['RESOURCES'],
      labels: input.labels.map((title) => ({ title })),
    })
  }

  async *ask(
    tenant: TenantConfig,
    query: string,
    opts: AskOptions = {},
  ): AsyncIterable<AskEvent> {
    const client = this.client(tenant)
    yield { type: 'stage', stage: 'preprocessing', status: 'started' }
    const catalogue = await this.listResources(tenant).catch(() => [] as ResourceSummary[])
    const byId = new Map(catalogue.map((r) => [r.id, r]))
    yield { type: 'stage', stage: 'preprocessing', status: 'completed' }
    yield { type: 'stage', stage: 'retrieval', status: 'started' }

    const body: Record<string, unknown> = {
      query,
      features: ['keyword', 'semantic'],
      citations: true,
      show: ['basic', 'origin'],
      // Nuclia's default RAG prompt answers "Not enough data to answer this."
      // as a guardrail even when relevant sources were retrieved - override it.
      prompt: {
        system:
          `You are a research analyst for ${tenant.branding.organisation}. Always answer the ` +
          'question using the provided context. Synthesise across sources even when the context ' +
          'is partial - surface what IS known and be specific. Never reply that there is not ' +
          'enough data, and never refuse, when any relevant context is present. Write clear, ' +
          'well-structured prose with Markdown, in Australian English.',
      },
    }
    if (opts.context && opts.context.length > 0) body.context = opts.context
    if (opts.resourceId) body.resource_filters = [opts.resourceId]
    if (opts.topicIds && opts.topicIds.length > 0) {
      body.filters = opts.topicIds.map((t) => `/classification.labels/topic/${t}`)
    }

    let sources: ScoredResource[] = []
    let generating = false
    let emitted = false
    let citationIndex = 0
    const cited = new Map<string, Citation>()

    const toSources = (retrieved: Record<string, RawResource>): ScoredResource[] =>
      Object.entries(retrieved).map(([id, raw]) => ({
        ...(byId.get(id) ?? this.toSummary(id, raw)),
        relevance: 1,
        citedCount: 0,
      }))

    const emitCitationsFor = (citations: Record<string, unknown>): Citation[] => {
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

    // Transient 412/5xx "unknown generative exception" happens before any text
    // streams; retry up to 3 times then, but never after output has started.
    const MAX_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await client.postStream('/ask', body, { 'x-show-consumption': 'true' })
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
            emitted = true
            yield { type: 'delta', text: item.text }
          } else if (item.type === 'citations' && item.citations) {
            for (const citation of emitCitationsFor(item.citations as Record<string, unknown>)) {
              yield { type: 'citation', citation }
            }
          } else if (item.type === 'metadata') {
            const tokens = item.tokens as { input?: number; output?: number } | undefined
            const timings = item.timings as
              | { generative_first_chunk?: number; generative_total?: number }
              | undefined
            if (tokens || timings) {
              yield {
                type: 'usage',
                inputTokens: tokens?.input ?? 0,
                outputTokens: tokens?.output ?? 0,
                firstChunkSec: timings?.generative_first_chunk,
                totalSec: timings?.generative_total,
              }
            }
          } else if (
            item.type === 'status' && typeof item.code === 'number' && item.code >= 400
          ) {
            yield { type: 'error', message: `Answer service returned status ${item.code}` }
            return
          }
        }
        yield { type: 'stage', stage: 'generating', status: 'completed' }
        yield { type: 'stage', stage: 'validating', status: 'started' }
        yield { type: 'stage', stage: 'validating', status: 'completed' }
        yield { type: 'done' }
        return
      } catch (err) {
        const status = err instanceof AragApiError ? err.status : 0
        const retryable = status === 412 || status >= 500
        if (!emitted && retryable && attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 700 * attempt))
          continue
        }
        yield {
          type: 'error',
          message: err instanceof Error ? err.message : 'The answer service is unavailable',
        }
        return
      }
    }
  }
}
