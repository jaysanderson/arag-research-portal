import type {
  AskEvent,
  CatalogItem,
  CatalogPage,
  Citation,
  FacetCounts,
  GraphData,
  KbAgent,
  KbCounters,
  Labelset,
  Question,
  RecentResource,
  ResourceContent,
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
        hidden: (r as { hidden?: boolean }).hidden ?? false,
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
    input: { url: string; title?: string; hidden?: boolean },
  ): Promise<{ id: string }> {
    const res = await this.client(tenant).postJson<{ uuid?: string }>('/resources', {
      title: input.title ?? input.url,
      icon: 'application/stf-link',
      origin: { url: input.url },
      links: { link: { uri: input.url } },
      ...(input.hidden ? { hidden: true } : {}),
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
      // Central retrieval settings live on the box; explicit params override.
      search_configuration: 'portal-search',
    }
    const filters = (opts.topicIds ?? []).map((t) => `/classification.labels/topic/${t}`)
    if (filters.length > 0) body.filters = filters
    type FindResponse = {
      resources?: Record<
        string,
        RawResource & {
          fields?: Record<
            string,
            { paragraphs?: Record<string, { score?: number; text?: string }> }
          >
        }
      >
    }
    const findWithFallback = async (): Promise<FindResponse> => {
      try {
        return await client.postJson<FindResponse>('/find', body)
      } catch (err) {
        if (err instanceof AragApiError && err.status >= 400 && err.status < 500) {
          delete body.search_configuration
          return await client.postJson<FindResponse>('/find', body)
        }
        throw err
      }
    }
    const [found, all] = await Promise.all([
      findWithFallback(),
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
    params.set('hidden', 'false')
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
    const [primaryCountsAll, labelsets] = await Promise.all([
      this.facets(tenant, [primary]),
      this.labelsets(tenant).catch(() => []),
    ])
    // Facet keys are label slugs - show the labelset's display title instead.
    const displayTitle = new Map<string, string>()
    for (const ls of labelsets) {
      for (const label of ls.labels) {
        displayTitle.set(
          label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          label,
        )
      }
    }
    const pretty = (slug: string) =>
      displayTitle.get(slug) ??
        slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    const primaryCounts = primaryCountsAll[primary] ?? {}
    const primaries = Object.entries(primaryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
    const nodes: GraphData['nodes'] = primaries.map(([label, weight]) => ({
      id: `${primary}:${label}`,
      label: pretty(label),
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
      nodes.push({ id: `${secondary}:${label}`, label: pretty(label), group: 'secondary', weight })
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
    input: {
      id: string
      title: string
      multiple: boolean
      labels: string[]
      kind?: 'RESOURCES' | 'PARAGRAPHS'
    },
  ): Promise<void> {
    await this.client(tenant).postJson(`/labelset/${input.id}`, {
      title: input.title,
      color: '#556b5f',
      multiple: input.multiple,
      kind: [input.kind ?? 'RESOURCES'],
      labels: input.labels.map((title) => ({ title })),
    })
  }

  // -------------------------------------------------------------------------
  // Data-augmentation agents (DA tasks on the data-plane host).
  // -------------------------------------------------------------------------

  /** The box's configured generative model - DA tasks must pin it. */
  async generativeModel(tenant: TenantConfig): Promise<string> {
    try {
      const cfg = await this.client(tenant).getJson<{ generative_model?: string }>(
        '/configuration',
      )
      return cfg.generative_model ?? ''
    } catch {
      return ''
    }
  }

  async listAgents(tenant: TenantConfig): Promise<KbAgent[]> {
    const raw = await this.client(tenant).dpJson<Record<string, unknown>>('GET', '/tasks')
    const agents: KbAgent[] = []
    const collect = (entries: unknown) => {
      if (!Array.isArray(entries)) return
      for (const entry of entries) {
        const e = entry as {
          id?: string
          task?: { name?: string }
          parameters?: { name?: string }
        }
        const id = e.id
        if (!id || agents.some((a) => a.id === id)) continue
        agents.push({
          id,
          task: e.task?.name ?? 'unknown',
          title: e.parameters?.name ?? e.task?.name ?? id,
        })
      }
    }
    for (const value of Object.values(raw ?? {})) collect(value)
    return agents
  }

  async startAgent(
    tenant: TenantConfig,
    input: {
      task: string
      title: string
      operations: unknown[]
      applyExisting: boolean
      model: string
    },
  ): Promise<void> {
    const parameters: Record<string, unknown> = {
      name: input.title,
      on: 1,
      operations: input.operations,
    }
    if (input.model) parameters.llm = { model: input.model }
    await this.client(tenant).dpJson('POST', '/task/start', {
      name: input.task,
      parameters,
      apply: input.applyExisting ? 'ALL' : 'NEW',
      enabled: true,
    })
  }

  /** REMi answer-quality scores (0-5) for a generated answer. */
  async remi(
    tenant: TenantConfig,
    input: { question: string; answer: string; contexts: string[] },
  ): Promise<
    { answerRelevance: number | null; groundedness: number | null; contextRelevance: number | null }
  > {
    const raw = await this.client(tenant).postJson<{
      answer_relevance?: { score?: number } | null
      context_relevance?: (number | null)[] | null
      groundedness?: (number | null)[] | null
    }>('/predict/remi', {
      user_id: 'research-portal',
      question: input.question,
      answer: input.answer,
      contexts: input.contexts.slice(0, 20).map((c) => c.slice(0, 2000)),
    })
    const clean = (values?: (number | null)[] | null): number[] =>
      (values ?? []).filter((v): v is number => typeof v === 'number')
    // Context expansion pads retrieval with neighbouring/graph paragraphs, so
    // averages over ALL contexts under-report. Groundedness asks "is the
    // answer supported by the retrieved material" - the best supporting
    // context answers that (max). Context relevance reports the top five.
    const grounded = clean(raw.groundedness)
    const relevant = clean(raw.context_relevance).sort((a, b) => b - a).slice(0, 5)
    return {
      answerRelevance: raw.answer_relevance?.score ?? null,
      groundedness: grounded.length ? Math.max(...grounded) : null,
      contextRelevance: relevant.length
        ? Math.round((relevant.reduce((a, b) => a + b, 0) / relevant.length) * 10) / 10
        : null,
    }
  }

  /** The REAL extracted knowledge graph: entity-relation-entity paths. */
  async relationsGraph(tenant: TenantConfig): Promise<{
    nodes: { id: string; group: string; weight: number }[]
    edges: { source: string; target: string; label: string }[]
  }> {
    try {
      const raw = await this.client(tenant).postJson<{
        paths?: {
          source?: { value?: string; group?: string }
          relation?: { label?: string }
          destination?: { value?: string; group?: string }
        }[]
      }>('/graph', { query: { prop: 'path' }, top_k: 200 })
      const weight = new Map<string, { group: string; weight: number }>()
      const edges: { source: string; target: string; label: string }[] = []
      const seenEdge = new Set<string>()
      for (const path of raw.paths ?? []) {
        const s = path.source?.value
        const d = path.destination?.value
        if (!s || !d || s === d) continue
        const sg = path.source?.group ?? ''
        const dg = path.destination?.group ?? ''
        // Entity-entity relations only: skip built-in NER groups, label
        // assignment paths (topic/... targets) and raw resource-id nodes.
        if (/^[A-Z0-9_]+$/.test(sg) || /^[A-Z0-9_]+$/.test(dg)) continue
        if (s.includes('/') || d.includes('/')) continue
        if (/^[0-9a-f]{32}$/.test(s) || /^[0-9a-f]{32}$/.test(d)) continue
        const label = path.relation?.label ?? 'related to'
        const key = `${s}|${label}|${d}`
        if (seenEdge.has(key)) continue
        seenEdge.add(key)
        edges.push({ source: s, target: d, label })
        for (const [value, group] of [[s, sg], [d, dg]] as const) {
          const entry = weight.get(value) ?? { group, weight: 0 }
          entry.weight += 1
          if (group) entry.group = group
          weight.set(value, entry)
        }
      }
      const nodes = [...weight.entries()]
        .map(([id, v]) => ({ id, group: v.group, weight: v.weight }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 80)
      const keep = new Set(nodes.map((n) => n.id))
      return { nodes, edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)) }
    } catch {
      return { nodes: [], edges: [] }
    }
  }

  /** Grounded multi-resource summary via the box's summarize endpoint. */
  async summarize(
    tenant: TenantConfig,
    resourceIds: string[],
    kind: 'simple' | 'extended' = 'simple',
  ): Promise<string> {
    const raw = await this.client(tenant).postJson<{
      summary?: string
      resources?: Record<string, { summary?: string }>
    }>('/summarize', { resources: resourceIds.slice(0, 20), summary_kind: kind })
    if (raw.summary?.trim()) return raw.summary
    return Object.values(raw.resources ?? {})
      .map((r) => r.summary ?? '')
      .filter(Boolean)
      .join('\n\n')
  }

  /** The platform's rephrasing of a query; null when unchanged/unavailable. */
  async rephrase(tenant: TenantConfig, question: string): Promise<string | null> {
    try {
      const raw = await this.client(tenant).postJson<unknown>('/predict/rephrase', {
        question,
        user_id: 'research-portal',
      })
      const text = typeof raw === 'string'
        ? raw
        : (raw as { rephrased_query?: string; text?: string }).rephrased_query ??
          (raw as { text?: string }).text ?? ''
      // The predict endpoint appends a single status digit to the rephrased text.
      const cleaned = text.trim().replace(/[01]$/, '').trim().replace(/\?+$/, (m) => m.slice(0, 1))
      if (!cleaned || cleaned.toLowerCase() === question.trim().toLowerCase()) return null
      return cleaned
    } catch {
      return null
    }
  }

  /** Give the platform feedback on an answer (its learning loop). */
  async feedback(
    tenant: TenantConfig,
    input: { learningId: string; good: boolean; text?: string },
  ): Promise<void> {
    await this.client(tenant).postJson('/feedback', {
      ident: input.learningId,
      good: input.good,
      task: 'CHAT',
      ...(input.text ? { feedback: input.text } : {}),
    })
  }

  /** Show or hide a resource from searchers (draft/publish workflow). */
  async setResourceHidden(tenant: TenantConfig, id: string, hidden: boolean): Promise<void> {
    await this.client(tenant).patchJson(`/resource/${id}`, { hidden })
    this.invalidateCatalogue(tenant.slug)
  }

  /** Type-ahead: entity and title suggestions from the box's suggest index. */
  async typeahead(
    tenant: TenantConfig,
    query: string,
  ): Promise<{ entities: string[]; titles: string[] }> {
    try {
      const raw = await this.client(tenant).getJson<{
        entities?: { entities?: { value?: string }[] }
        paragraphs?: {
          results?: { rid?: string; field?: string; text?: string }[]
        }
      }>(
        `/suggest?query=${encodeURIComponent(query)}&features=entities&features=paragraph`,
      )
      // The graph agent occasionally extracts vague time/direction words as
      // entities - keep suggestions to substantive names.
      const NOISE =
        /^(recent|early|late|last|next|this|coming|current|previous)\b|^(north|south|east|west)$|^(january|february|march|april|may|june|july|august|september|october|november|december)\b|^\d{1,4}$/i
      const entities = (raw.entities?.entities ?? [])
        .map((e) => (e.value ?? '').trim())
        .filter((v) => v.length > 2 && !NOISE.test(v) && !v.includes('\n'))
        .slice(0, 6)
      const seen = new Set<string>()
      const titles: string[] = []
      for (const r of raw.paragraphs?.results ?? []) {
        if (r.field !== 'title' || !r.text || !r.rid || seen.has(r.rid)) continue
        seen.add(r.rid)
        titles.push(r.text)
        if (titles.length >= 5) break
      }
      return { entities, titles }
    } catch {
      return { entities: [], titles: [] }
    }
  }

  /** Named search configurations on the box - the wiring for every surface. */
  async listSearchConfigs(tenant: TenantConfig): Promise<Record<string, unknown>> {
    try {
      return await this.client(tenant).getJson<Record<string, unknown>>('/search_configurations')
    } catch {
      return {}
    }
  }

  /**
   * Ensure the portal's named search configurations exist on the box - one per
   * surface, so retrieval behaviour is configured centrally rather than ad hoc.
   */
  async ensureSearchConfigs(tenant: TenantConfig): Promise<string[]> {
    const client = this.client(tenant)
    const desired: Record<string, unknown> = {
      'portal-search': {
        kind: 'find',
        config: { features: ['keyword', 'semantic'], top_k: 20 },
      },
      'portal-ask': {
        kind: 'ask',
        config: { features: ['keyword', 'semantic'], citations: true },
      },
      'portal-typeahead': {
        kind: 'find',
        config: { features: ['keyword'], top_k: 8 },
      },
    }
    const created: string[] = []
    for (const [name, body] of Object.entries(desired)) {
      try {
        await client.postJson(`/search_configurations/${name}`, body)
        created.push(name)
      } catch {
        // Exists already or the deployment rejects the shape - not fatal.
      }
    }
    return created
  }

  /** Entity groups the graph agent has extracted (native knowledge graph). */
  async entityGroups(
    tenant: TenantConfig,
  ): Promise<{ group: string; entities: string[] }[]> {
    try {
      const client = this.client(tenant)
      const raw = await client.getJson<{
        groups?: Record<string, { entities?: Record<string, unknown> }>
      }>('/entitiesgroups')
      // Only custom-created groups (from the box's own graph agents). The
      // platform's built-in NER groups use ALL-CAPS codes (ORG, LOC, DATE...)
      // and are excluded from the portal's graph views.
      const names = Object.keys(raw.groups ?? {})
        .filter((name) => !/^[A-Z0-9_]+$/.test(name))
        .slice(0, 16)
      const out = await Promise.all(names.map(async (group) => {
        const inline = Object.keys(raw.groups?.[group]?.entities ?? {})
        if (inline.length > 0) return { group, entities: inline.slice(0, 100) }
        try {
          const detail = await client.getJson<{ entities?: Record<string, unknown> }>(
            `/entitiesgroup/${encodeURIComponent(group)}`,
          )
          return { group, entities: Object.keys(detail.entities ?? {}).slice(0, 100) }
        } catch {
          return { group, entities: [] }
        }
      }))
      return out.filter((g) => g.entities.length > 0)
    } catch {
      return []
    }
  }

  async deleteAgent(tenant: TenantConfig, id: string): Promise<void> {
    await this.client(tenant).dpJson('DELETE', `/task/${id}`)
  }

  /** Typed full content of a resource for the detail view. */
  async resourceContent(tenant: TenantConfig, id: string): Promise<ResourceContent | null> {
    let raw: RawResource & {
      icon?: string
      origin?: { url?: string }
      summary?: string
      data?: Record<
        string,
        Record<string, {
          value?: { body?: string; file?: { content_type?: string } }
          extracted?: {
            text?: { text?: string }
            metadata?: {
              metadata?: {
                paragraphs?: { start?: number; end?: number; start_seconds?: number[] }[]
              }
            }
          }
        }>
      >
    }
    try {
      raw = await this.client(tenant).getJson(
        `/resource/${id}?show=basic&show=origin&show=values&show=extracted&show=extra&extracted=text&extracted=metadata`,
      )
    } catch (err) {
      if (err instanceof AragApiError && err.status === 404) return null
      throw err
    }
    const icon = raw.icon ?? ''
    const texts: { fieldId: string; text: string }[] = []
    const files: { group: string; fieldId: string; contentType?: string }[] = []
    const transcript: { text: string; startSec?: number }[] = []
    for (const [group, fields] of Object.entries(raw.data ?? {})) {
      for (const [fieldId, field] of Object.entries(fields ?? {})) {
        const text = field.extracted?.text?.text ?? field.value?.body ?? ''
        if (text.trim()) texts.push({ fieldId: `${group}/${fieldId}`, text })
        if (group === 'files') {
          files.push({
            group: 'file',
            fieldId,
            contentType: field.value?.file?.content_type,
          })
        }
        const paragraphs = field.extracted?.metadata?.metadata?.paragraphs ?? []
        for (const p of paragraphs) {
          const startSec = Array.isArray(p.start_seconds) ? p.start_seconds[0] : undefined
          if (startSec === undefined) continue
          const chunk = text.slice(p.start ?? 0, p.end ?? 0).trim()
          if (chunk) transcript.push({ text: chunk, startSec })
        }
      }
    }
    const originUrl = raw.origin?.url
    const kind: ResourceContent['kind'] = originUrl && Object.keys(raw.data?.links ?? {}).length
      ? 'web'
      : icon === 'application/pdf'
      ? 'pdf'
      : icon.startsWith('video/')
      ? 'video'
      : icon.startsWith('audio/')
      ? 'audio'
      : icon.startsWith('image/')
      ? 'image'
      : files.length > 0
      ? 'file'
      : 'text'
    return {
      id,
      title: raw.title || id,
      kind,
      originUrl,
      summary: raw.summary || (raw.extra?.metadata as { summary?: string } | undefined)?.summary,
      texts,
      transcript,
      files,
    }
  }

  /** Stream the platform-generated thumbnail for a resource, if any. */
  async thumbnailResponse(tenant: TenantConfig, id: string): Promise<Response | null> {
    const client = this.client(tenant)
    let raw: { thumbnail?: string }
    try {
      raw = await client.getJson<{ thumbnail?: string }>(`/resource/${id}?show=basic`)
    } catch {
      return null
    }
    const thumb = raw.thumbnail
    if (!thumb) return null
    // The platform returns a path like /kb/<id>/resource/<rid>/... - strip the
    // kb prefix since our client base already ends at /kb/<id>.
    const path = thumb.replace(/^\/kb\/[^/]+/, '')
    if (!path.startsWith('/')) return null
    try {
      return await client.fileResponse(path)
    } catch {
      return null
    }
  }

  /** Proxy a stored file field (range-aware) for inline rendering. */
  fileStream(tenant: TenantConfig, id: string, fieldId: string, range?: string) {
    return this.client(tenant).fileResponse(
      `/resource/${id}/file/${fieldId}/download/field`,
      range,
    )
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
      search_configuration: 'portal-ask',
      // Nuclia's default RAG prompt answers "Not enough data to answer this."
      // as a guardrail even when relevant sources were retrieved - override it.
      prompt: {
        system: opts.systemPrompt?.trim() ||
          `You are a research analyst for ${tenant.branding.organisation}. Always answer the ` +
            'question using the provided context. Synthesise across sources even when the context ' +
            'is partial - surface what IS known and be specific. Never reply that there is not ' +
            'enough data, and never refuse, when any relevant context is present. Write clear, ' +
            'well-structured prose with Markdown, in Australian English.',
      },
    }
    if (opts.context && opts.context.length > 0) {
      // The app models turns as USER/AGENT; this deployment's /ask context
      // enum is NUCLIA | USER (422 otherwise) - translate at the boundary.
      body.context = opts.context.map((turn) => ({
        author: turn.author === 'AGENT' ? 'NUCLIA' : 'USER',
        text: turn.text,
      }))
    }
    if (opts.resourceId) body.resource_filters = [opts.resourceId]
    if (opts.topicIds && opts.topicIds.length > 0) {
      body.filters = opts.topicIds.map((t) => `/classification.labels/topic/${t}`)
    }
    // Agentic retrieval upgrades: widen grounding windows around each hit and
    // walk the knowledge graph from entities detected in the query (uses the
    // box's graph extraction agent). Degrades gracefully if unsupported.
    const strategies: Record<string, unknown>[] = opts.depth === 'deep'
      ? [{ name: 'full_resource' }]
      : [
        { name: 'neighbouring_paragraphs', before: 2, after: 2 },
        { name: 'graph_beta', hops: 2, agentic_graph_only: true },
      ]
    if (opts.prequeries && opts.prequeries.length > 0) {
      strategies.push({
        name: 'prequeries',
        queries: opts.prequeries.slice(0, 8).map((q) => ({
          request: { query: q, features: ['keyword', 'semantic'] },
          weight: 1,
        })),
      })
    }
    body.rag_strategies = strategies
    if (opts.images) {
      body.rag_images_strategies = [{ name: 'page_image' }, { name: 'tables' }]
    }

    let sources: ScoredResource[] = []
    const contextTexts: string[] = []
    let fullAnswer = ''
    const REFUSAL = 'not enough data to answer this.'
    let refusalPossible = true
    let generating = false
    let emitted = false
    let citationIndex = 0
    const cited = new Map<string, Citation>()

    const toSources = (
      retrieved: Record<
        string,
        RawResource & {
          fields?: Record<
            string,
            { paragraphs?: Record<string, { score?: number; text?: string }> }
          >
        }
      >,
    ): ScoredResource[] =>
      Object.entries(retrieved).map(([id, raw]) => {
        let best = 0
        let passage: string | undefined
        for (const field of Object.values(raw.fields ?? {})) {
          for (const paragraph of Object.values(field.paragraphs ?? {})) {
            if (paragraph.text) contextTexts.push(paragraph.text)
            if ((paragraph.score ?? 0) >= best) {
              best = paragraph.score ?? 0
              passage = paragraph.text ?? passage
            }
          }
        }
        return {
          ...(byId.get(id) ?? this.toSummary(id, raw)),
          relevance: 1,
          citedCount: 0,
          matchedPassage: passage,
        }
      })

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
      // A retried attempt starts clean - no half-accumulated answer, contexts
      // or citations from the failed one.
      if (attempt > 1) {
        sources = []
        contextTexts.length = 0
        fullAnswer = ''
        refusalPossible = true
        generating = false
        citationIndex = 0
        cited.clear()
      }
      try {
        const res = await client.postStream('/ask', body, { 'x-show-consumption': 'true' })
        const learningId = res.headers.get('nuclia-learning-id')
        if (learningId) yield { type: 'learning', id: learningId }
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
            fullAnswer += item.text
            // Hold back the platform's bare guardrail refusal: buffer while
            // the answer is still a prefix of it, and swap in honest guidance
            // if that is all the model produced.
            if (refusalPossible) {
              const lowered = fullAnswer.trim().toLowerCase()
              // Keep buffering while the text is still a prefix of the
              // guardrail sentence, or is the full sentence with only a few
              // trailing characters - but the moment real content follows it,
              // release everything (the model refused then kept going).
              if (
                REFUSAL.startsWith(lowered) ||
                (lowered.startsWith(REFUSAL) && lowered.length <= REFUSAL.length + 12)
              ) {
                continue
              }
              refusalPossible = false
              emitted = true
              yield { type: 'delta', text: fullAnswer }
              continue
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
        let refused = false
        if (refusalPossible && fullAnswer.trim()) {
          // The model produced only the guardrail sentence - replace it with
          // guidance the reader can act on.
          refused = true
          fullAnswer = ''
          yield {
            type: 'delta',
            text: "This portal's content does not hold enough relevant material to answer this " +
              'confidently. Try rephrasing the question, narrowing it to a topic, or browsing ' +
              'the Library to see what it covers.',
          }
        }
        yield { type: 'stage', stage: 'generating', status: 'completed' }
        yield { type: 'stage', stage: 'validating', status: 'started' }
        // REMi trust signal: score the finished answer against the full
        // retrieved context. Best effort with a hard time cap - the answer is
        // never held hostage by the scorer.
        if (fullAnswer.trim() && contextTexts.length > 0) {
          try {
            let capTimer: ReturnType<typeof setTimeout> | undefined
            const quality = await Promise.race([
              this.remi(tenant, {
                question: query,
                answer: fullAnswer,
                contexts: contextTexts,
              }),
              new Promise<null>((resolve) => {
                capTimer = setTimeout(() => resolve(null), 12000)
              }),
            ])
            clearTimeout(capTimer)
            if (quality) yield { type: 'quality', ...quality }
          } catch {
            // scoring unavailable - skip silently
          }
        }
        yield { type: 'stage', stage: 'validating', status: 'completed' }
        yield { type: 'done', refused }
        return
      } catch (err) {
        const status = err instanceof AragApiError ? err.status : 0
        // A 4xx before any output usually means an optional capability
        // (graph strategy) is unsupported here - shed it and go again.
        if (
          !emitted && status >= 400 && status < 500 &&
          (body.rag_strategies || body.search_configuration || body.rag_images_strategies)
        ) {
          delete body.rag_strategies
          delete body.search_configuration
          delete body.rag_images_strategies
          continue
        }
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
