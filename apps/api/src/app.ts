import { type Context, Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { GenerateKindSchema } from '@research-portal/core'
import type { MigrationEvent, TenantConfig } from '@research-portal/core'
import {
  AragApiError,
  type AragProvider,
  KbClient,
  KnowledgeBoxNotConnectedError,
  parseKbUrl,
  type RetrievalProvider,
} from '@research-portal/retrieval'
import { type NewTenantInput, TenantStore } from './tenants.ts'
import { BindingStore } from './bindings.ts'
import { accountOpsAvailable, createKnowledgeBox, enableHiddenResources } from './arag-account.ts'
import { GENERATE_SCHEMAS } from './generate-schemas.ts'
import { analyseTenant } from './analyse.ts'
import { implementKgStrategy, KgProposalStore, proposeKgStrategy } from './kg.ts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { discoverLinks } from './crawl.ts'
import { InsightsStore, SessionsStore, SourceStore, WatchStore } from './stores.ts'
import { syncSource } from './scheduler.ts'

const searchQuerySchema = z.object({ q: z.string().min(1) })
const askBodySchema = z.object({
  query: z.string().min(1),
  context: z
    .object({ author: z.enum(['USER', 'AGENT']), text: z.string() })
    .array()
    .max(24)
    .optional(),
  resourceId: z.string().optional(),
  topicIds: z.string().array().max(12).optional(),
  depth: z.enum(['default', 'deep']).optional(),
  prequeries: z.string().min(3).array().max(8).optional(),
})
const connectBodySchema = z.object({
  url: z.string().min(12),
  token: z.string().min(20),
})
const createKbBodySchema = z.object({ title: z.string().min(1).max(80).optional() })
const linkBodySchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  hidden: z.boolean().optional(),
})
const feedbackBodySchema = z.object({
  learningId: z.string().min(8),
  good: z.boolean(),
  text: z.string().max(2000).optional(),
})
const summarizeBodySchema = z.object({
  resourceIds: z.string().min(1).array().min(1).max(20),
  kind: z.enum(['simple', 'extended']).optional(),
})
const subqueriesBodySchema = z.object({ query: z.string().min(3).max(2000) })
const estateAskSchema = z.object({ query: z.string().min(1).max(2000) })
const sessionPutSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  updatedAt: z.string(),
  messages: z.unknown().array().max(500),
})
const watchBodySchema = z.object({ query: z.string().min(2).max(500) })
const sourceBodySchema = z.object({ url: z.string().url(), auto: z.boolean().optional() })
const hiddenBodySchema = z.object({ hidden: z.boolean() })

const SUBQUERIES_SCHEMA = {
  name: 'research_subquestions',
  description: 'Decompose a research question into focused sub-questions',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: { questions: { type: 'array', items: { type: 'string' } } },
    required: ['questions'],
  },
}
const textBodySchema = z.object({ title: z.string().min(1), body: z.string().min(1) })
const migrateBodySchema = z.object({ from: z.string().min(1), to: z.string().min(1) })
const generateBodySchema = z.object({
  kind: GenerateKindSchema,
  query: z.string().min(3).max(2000),
})
const renameTenantSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  organisation: z.string().min(1).max(120).optional(),
  tagline: z.string().min(1).max(160).optional(),
})
const kgImplementSchema = z.object({
  applyExisting: z.boolean(),
  includeSummaries: z.boolean().optional(),
  includeMemory: z.boolean().optional(),
})
const newTenantSchema = z.object({
  name: z.string().min(2).max(60),
  organisation: z.string().max(120).optional(),
  tagline: z.string().max(160).optional(),
})
const promptsSchema = z.object({
  ask: z.string().max(4000).optional(),
  images: z.boolean().optional(),
})
const labelsetBodySchema = z.object({
  title: z.string().min(1).max(60),
  multiple: z.boolean(),
  labels: z.string().min(1).array().max(40),
})

/** Strip quotes, whitespace and an accidental "Bearer " prefix from a pasted token. */
const cleanToken = (raw: string) =>
  raw.trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '').trim()

export interface BuildAppOptions {
  provider: RetrievalProvider
  /** Tenant registry; a fresh store (seeds only) when omitted. */
  tenants?: TenantStore
  /** The live provider's management surface; absent in tests. */
  management?: AragProvider
  bindings?: BindingStore
  zone?: string
  adminPasscode?: string
  /** Passcode value the admin login should prefill (pre-release convenience). */
  adminPrefill?: string
  /** Called after a tenant is rebound so the provider can drop its caches. */
  invalidate?: (slug: string) => void
}

export function buildApp(opts: BuildAppOptions): Hono {
  const { provider } = opts
  const bindings = opts.bindings ?? new BindingStore({})
  const tenants = opts.tenants ?? new TenantStore({})
  const insights = new InsightsStore()
  const sessions = new SessionsStore()
  const watches = new WatchStore()
  const sources = new SourceStore()
  const clientId = (c: Context): string => c.req.header('x-rp-client') ?? 'anonymous'
  const app = new Hono()

  app.use('/api/*', cors({ origin: (origin) => origin }))

  app.onError((err, c) => {
    if (err instanceof KnowledgeBoxNotConnectedError) {
      return c.json({ error: 'knowledge_box_not_connected', slug: err.slug }, 503)
    }
    console.error(err)
    return c.json({ error: 'internal_error' }, 500)
  })

  const tenant = (slug: string): TenantConfig | undefined => tenants.get(slug)

  app.get('/api/tenants', (c) => c.json(tenants.list()))

  const brandingDir = process.env.BRANDING_PATH ?? './data/branding'
  const brandingFile = (slug: string, kind: 'logo' | 'hero'): string | null => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'svg']) {
      const path = `${brandingDir}/${slug}-${kind}.${ext}`
      if (existsSync(path)) return path
    }
    return null
  }
  const withBrandingUrls = (config: TenantConfig): TenantConfig => ({
    ...config,
    branding: {
      ...config.branding,
      ...(brandingFile(config.slug, 'logo')
        ? { logoUrl: `/api/t/${config.slug}/branding/logo` }
        : {}),
      ...(brandingFile(config.slug, 'hero')
        ? { heroImageUrl: `/api/t/${config.slug}/branding/hero` }
        : {}),
    },
  })

  app.get('/api/t/:slug/config', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(withBrandingUrls(config))
  })

  app.get('/api/t/:slug/branding/:kind', (c) => {
    const config = tenant(c.req.param('slug'))
    const kind = c.req.param('kind')
    if (!config || (kind !== 'logo' && kind !== 'hero')) {
      return c.json({ error: 'not_found' }, 404)
    }
    const path = brandingFile(config.slug, kind)
    if (!path) return c.json({ error: 'not_found' }, 404)
    const ext = path.split('.').pop() ?? 'png'
    const type = ext === 'svg'
      ? 'image/svg+xml'
      : ext === 'webp'
      ? 'image/webp'
      : `image/${ext === 'jpg' ? 'jpeg' : ext}`
    return new Response(readFileSync(path), {
      headers: { 'content-type': type, 'cache-control': 'public, max-age=300' },
    })
  })

  app.get('/api/t/:slug/resources/:id/thumbnail', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!opts.management) return c.json({ error: 'not_found' }, 404)
    const upstream = await opts.management.thumbnailResponse(config, c.req.param('id'))
    if (!upstream) return c.json({ error: 'not_found' }, 404)
    const headers = new Headers()
    const type = upstream.headers.get('content-type')
    if (type) headers.set('content-type', type)
    headers.set('cache-control', 'public, max-age=600')
    return new Response(upstream.body, { status: 200, headers })
  })

  app.get('/api/t/:slug/search', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = searchQuerySchema.safeParse({ q: c.req.query('q') })
    if (!parsed.success) return c.json({ error: 'missing_query' }, 400)
    const modeRaw = c.req.query('mode')
    const mode = modeRaw === 'semantic' || modeRaw === 'keyword' ? modeRaw : 'hybrid'
    const topicIds = (c.req.query('topics') ?? '').split(',').filter(Boolean)
    return c.json(await provider.search(config, parsed.data.q, { mode, topicIds }))
  })

  app.get('/api/t/:slug/catalog', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const sortRaw = c.req.query('sort')
    const orderRaw = c.req.query('order')
    return c.json(
      await provider.catalog(config, {
        page: Number(c.req.query('page') ?? 0) || 0,
        pageSize: Math.min(Number(c.req.query('pageSize') ?? 24) || 24, 100),
        query: c.req.query('q') || undefined,
        topicIds: (c.req.query('topics') ?? '').split(',').filter(Boolean),
        sortField: sortRaw === 'modified' || sortRaw === 'title' ? sortRaw : 'created',
        sortOrder: orderRaw === 'asc' ? 'asc' : 'desc',
      }),
    )
  })

  app.get('/api/t/:slug/facets', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const labelsets = (c.req.query('ls') ?? 'topic').split(',').filter(Boolean)
    return c.json(await provider.facets(config, labelsets))
  })

  app.get('/api/t/:slug/labelsets', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(await provider.labelsets(config))
  })

  app.get('/api/t/:slug/suggest', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(await provider.suggest(config))
  })

  app.get('/api/t/:slug/resources', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(await provider.listResources(config))
  })

  app.get('/api/t/:slug/resources/:id', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const resource = await provider.resource(config, c.req.param('id'))
    if (!resource) return c.json({ error: 'unknown_resource' }, 404)
    return c.json(resource)
  })

  app.get('/api/t/:slug/resources/:id/content', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!opts.management) return c.json({ error: 'management_unavailable' }, 503)
    const content = await opts.management.resourceContent(config, c.req.param('id'))
    if (!content) return c.json({ error: 'unknown_resource' }, 404)
    return c.json(content)
  })

  app.get('/api/t/:slug/resources/:id/file/:fieldId', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!opts.management) return c.json({ error: 'management_unavailable' }, 503)
    const upstream = await opts.management.fileStream(
      config,
      c.req.param('id'),
      c.req.param('fieldId'),
      c.req.header('range'),
    )
    const headers = new Headers()
    for (
      const h of [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'etag',
        'last-modified',
      ]
    ) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    headers.set('content-disposition', 'inline')
    return new Response(upstream.body, { status: upstream.status, headers })
  })

  app.get('/api/t/:slug/typeahead', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const q = (c.req.query('q') ?? '').trim()
    if (!opts.management || q.length < 2) return c.json({ entities: [], titles: [] })
    return c.json(await opts.management.typeahead(config, q))
  })

  app.get('/api/t/:slug/graph/relations', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!opts.management) return c.json({ nodes: [], edges: [] })
    return c.json(await opts.management.relationsGraph(config))
  })

  app.get('/api/t/:slug/entities', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!opts.management) return c.json([])
    return c.json(await opts.management.entityGroups(config))
  })

  app.get('/api/t/:slug/knowledge-box', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(bindings.status(config.slug))
  })

  app.get('/api/t/:slug/counters', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!opts.management) return c.json({ error: 'management_unavailable' }, 503)
    return c.json(await opts.management.counters(config))
  })

  app.get('/api/t/:slug/graph', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!opts.management) return c.json({ error: 'management_unavailable' }, 503)
    const primary = c.req.query('primary') ?? 'topic'
    const secondary = c.req.query('secondary') ?? 'kind'
    return c.json(await opts.management.graphData(config, primary, secondary))
  })

  app.post('/api/t/:slug/generate', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!opts.management) return c.json({ error: 'management_unavailable' }, 503)
    const parsed = generateBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    const schema = GENERATE_SCHEMAS[parsed.data.kind]
    try {
      const result = await opts.management.askStructured(config, schema, parsed.data.query)
      return c.json({ kind: parsed.data.kind, ...result })
    } catch (err) {
      const text = err instanceof Error ? err.message : ''
      const status = err instanceof AragApiError ? err.status : 0
      const message = /max_tokens|token|json/i.test(text) || status === 412 || status === 422
        ? 'The request was too large to generate - try a narrower or simpler ask.'
        : 'Generation failed - please try again.'
      return c.json({ error: 'generation_failed', message }, 502)
    }
  })

  app.post('/api/t/:slug/feedback', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!opts.management) return c.json({ error: 'management_unavailable' }, 503)
    const parsed = feedbackBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await opts.management.feedback(config, parsed.data)
      return c.json({ ok: true })
    } catch {
      return c.json({ error: 'feedback_failed' }, 502)
    }
  })

  app.post('/api/t/:slug/summarize', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!opts.management) return c.json({ error: 'management_unavailable' }, 503)
    const parsed = summarizeBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const summary = await opts.management.summarize(
        config,
        parsed.data.resourceIds,
        parsed.data.kind ?? 'simple',
      )
      if (!summary.trim()) return c.json({ error: 'empty_summary' }, 502)
      return c.json({ summary })
    } catch {
      return c.json({ error: 'summarize_failed' }, 502)
    }
  })

  app.post('/api/t/:slug/subqueries', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!opts.management) return c.json({ error: 'management_unavailable' }, 503)
    const parsed = subqueriesBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const result = await opts.management.askStructured(
        config,
        SUBQUERIES_SCHEMA,
        `Break this research question into 3 to 5 focused sub-questions that together cover it fully. Sub-questions must be answerable from the corpus and phrased as standalone questions: ${parsed.data.query}`,
      )
      const questions = ((result.object as { questions?: unknown }).questions ?? []) as string[]
      return c.json({
        questions: questions.filter((q) => typeof q === 'string' && q.trim().length > 3).slice(
          0,
          5,
        ),
      })
    } catch {
      return c.json({ questions: [] })
    }
  })

  // Entity dossier: the graph neighbourhood plus the resources that discuss it.
  app.get('/api/t/:slug/entity', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!opts.management) return c.json({ error: 'management_unavailable' }, 503)
    const name = c.req.query('name')?.trim()
    if (!name) return c.json({ error: 'invalid_request' }, 400)
    const [graph, results] = await Promise.all([
      opts.management.relationsGraph(config).catch(() => ({ nodes: [], edges: [] })),
      provider.search(config, name, { mode: 'hybrid', pageSize: 12 }).catch(() => null),
    ])
    const lower = name.toLowerCase()
    const neighbourIds = new Set<string>()
    const edges = graph.edges.filter((e) => {
      const hit = e.source.toLowerCase() === lower || e.target.toLowerCase() === lower
      if (hit) {
        neighbourIds.add(e.source)
        neighbourIds.add(e.target)
      }
      return hit
    })
    return c.json({
      name,
      relations: { nodes: graph.nodes.filter((n) => neighbourIds.has(n.id)), edges },
      resources: results?.resources ?? [],
    })
  })

  // --- Research-trail sessions, synced server-side per anonymous client ----

  app.get('/api/t/:slug/sessions', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(sessions.list(config.slug, clientId(c)))
  })

  app.get('/api/t/:slug/sessions/:id', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const session = sessions.get(config.slug, clientId(c), c.req.param('id'))
    return session ? c.json(session) : c.json({ error: 'not_found' }, 404)
  })

  app.put('/api/t/:slug/sessions/:id', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = sessionPutSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success || parsed.data.id !== c.req.param('id')) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    sessions.put(config.slug, clientId(c), parsed.data)
    return c.json({ ok: true })
  })

  app.delete('/api/t/:slug/sessions/:id', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    sessions.remove(config.slug, clientId(c), c.req.param('id'))
    return c.json({ ok: true })
  })

  // --- Saved searches / watches --------------------------------------------

  app.get('/api/t/:slug/watches', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(watches.list(config.slug, clientId(c)))
  })

  app.post('/api/t/:slug/watches', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = watchBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    return c.json(watches.add(config.slug, clientId(c), parsed.data.query))
  })

  app.post('/api/t/:slug/watches/:id/seen', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    watches.update(config.slug, c.req.param('id'), { changed: false })
    return c.json({ ok: true })
  })

  app.delete('/api/t/:slug/watches/:id', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    watches.remove(config.slug, clientId(c), c.req.param('id'))
    return c.json({ ok: true })
  })

  // Federated ask: stream one grounded answer per enabled portal.
  app.post('/api/ask-estate', async (c) => {
    const parsed = estateAskSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_query' }, 400)
    const targets = tenants.list().map((t) => tenants.get(t.slug)).filter(
      (t): t is TenantConfig => t !== undefined,
    )
    return streamSSE(c, async (stream) => {
      let chain: Promise<void> = Promise.resolve()
      const write = (slug: string, event: unknown) => {
        chain = chain.then(() => stream.writeSSE({ data: JSON.stringify({ slug, event }) }))
        return chain
      }
      await Promise.all(targets.map(async (config) => {
        const record = { citations: 0, groundedness: null as number | null, failed: false }
        try {
          for await (const event of provider.ask(config, parsed.data.query, {})) {
            if (event.type === 'citation') record.citations += 1
            if (event.type === 'quality') record.groundedness = event.groundedness
            if (event.type === 'error') record.failed = true
            if (
              event.type === 'delta' || event.type === 'done' || event.type === 'sources' ||
              event.type === 'quality' || event.type === 'error'
            ) {
              await write(config.slug, event)
            }
          }
        } catch (err) {
          record.failed = true
          await write(config.slug, {
            type: 'error',
            message: err instanceof Error ? err.message : 'unknown_error',
          })
        }
        try {
          // Estate asks count in each portal's insights too - same signal.
          insights.record(config.slug, {
            ts: new Date().toISOString(),
            question: parsed.data.query.slice(0, 500),
            answered: !record.failed && record.citations > 0,
            citations: record.citations,
            durationSec: null,
            answerRelevance: null,
            groundedness: record.groundedness,
            contextRelevance: null,
          })
        } catch {
          // best-effort
        }
      }))
      await chain
      await stream.writeSSE({
        data: JSON.stringify({ slug: null, event: { type: 'estate-done' } }),
      })
    })
  })

  // Convenience: which passcode to prefill on the admin login (pre-release
  // only; set ADMIN_PASSCODE_PREFILL empty to turn the prefill off).
  app.get('/api/admin-prefill', (c) => c.json({ passcode: opts.adminPrefill ?? '' }))

  // Admin: connect a knowledge box to a tenant. The administrator enters the
  // KB id and service-account token in the app; both stay server-side. When
  // ADMIN_PASSCODE is configured every admin call must present it.
  app.use('/api/admin/*', async (c, next) => {
    if (opts.adminPasscode && c.req.header('x-admin-passcode') !== opts.adminPasscode) {
      return c.json({ error: 'unauthorised' }, 401)
    }
    await next()
  })

  app.get('/api/admin/overview', async (c) => {
    const rows = await Promise.all(
      tenants.list(true).map(async (summary) => {
        const config = tenant(summary.slug)
        let resourceCount: number | null = null
        if (config) {
          try {
            resourceCount = (await provider.listResources(config)).length
          } catch {
            resourceCount = null
          }
        }
        return {
          tenant: summary,
          knowledgeBox: bindings.status(summary.slug),
          resourceCount,
          custom: tenants.isCustom(summary.slug),
          disabled: tenants.isDisabled(summary.slug),
        }
      }),
    )
    return c.json(rows)
  })

  app.delete('/api/admin/t/:slug/knowledge-box', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    bindings.remove(config.slug)
    opts.invalidate?.(config.slug)
    return c.json({ ok: true, status: bindings.status(config.slug) })
  })

  // Management routes need the live provider's management surface.
  const management = opts.management
  const requireManagement = (c: Context) =>
    management ? null : c.json({ error: 'management_unavailable' }, 503)

  app.post('/api/admin/tenants', async (c) => {
    const parsed = newTenantSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const config = tenants.add(parsed.data as NewTenantInput)
      return c.json({ ok: true, slug: config.slug })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'could not add the portal'
      return c.json({ error: 'invalid_request', message }, 400)
    }
  })

  app.delete('/api/admin/tenants/:slug', (c) => {
    const slug = c.req.param('slug')
    if (!tenants.isCustom(slug)) return c.json({ error: 'not_removable' }, 400)
    tenants.remove(slug)
    bindings.remove(slug)
    opts.invalidate?.(slug)
    return c.json({ ok: true })
  })

  app.post('/api/admin/t/:slug/knowledge-box/create', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    if (!accountOpsAvailable()) {
      return c.json({
        error: 'account_credentials_missing',
        message: 'Account credentials are not configured on this server.',
      }, 503)
    }
    const parsed = createKbBodySchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    const zone = opts.zone ?? 'aws-ap-southeast-2-1'
    try {
      const kbSlug = `portal-${config.slug}-${Date.now().toString(36)}`
      const binding = await createKnowledgeBox(
        zone,
        kbSlug,
        parsed.data.title ?? `${config.branding.productName}`,
      )
      bindings.set(config.slug, binding)
      opts.invalidate?.(config.slug)
      return c.json({ ok: true, status: bindings.status(config.slug) })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'creation failed'
      return c.json({ error: 'creation_failed', message }, 502)
    }
  })

  app.get('/api/admin/t/:slug/counters', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailable = requireManagement(c)
    if (unavailable) return unavailable
    return c.json(await management!.counters(config))
  })

  app.get('/api/admin/t/:slug/recent', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailable = requireManagement(c)
    if (unavailable) return unavailable
    return c.json(await management!.recentResources(config))
  })

  app.post('/api/admin/t/:slug/resources/link', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailable = requireManagement(c)
    if (unavailable) return unavailable
    const parsed = linkBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    return c.json(await management!.createLink(config, parsed.data))
  })

  app.post('/api/admin/t/:slug/resources/text', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailable = requireManagement(c)
    if (unavailable) return unavailable
    const parsed = textBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    return c.json(await management!.createText(config, { ...parsed.data, format: 'MARKDOWN' }))
  })

  app.post('/api/admin/t/:slug/resources/upload', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailable = requireManagement(c)
    if (unavailable) return unavailable
    const filename = decodeURIComponent(c.req.header('x-filename') ?? 'upload')
    const contentType = c.req.header('content-type') ?? 'application/octet-stream'
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.length === 0) return c.json({ error: 'empty_file' }, 400)
    if (bytes.length > 100 * 1024 * 1024) return c.json({ error: 'file_too_large' }, 413)
    return c.json(await management!.uploadFile(config, { filename, contentType, bytes }))
  })

  app.post('/api/admin/t/:slug/disable', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    tenants.setDisabled(config.slug, true)
    return c.json({ ok: true })
  })

  app.post('/api/admin/t/:slug/enable', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    tenants.setDisabled(config.slug, false)
    return c.json({ ok: true })
  })

  app.post('/api/admin/t/:slug/analyse', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailableAn = requireManagement(c)
    if (unavailableAn) return unavailableAn
    return streamSSE(c, async (stream) => {
      try {
        for await (
          const event of analyseTenant(
            management!,
            tenants,
            config,
            (slug) => opts.invalidate?.(slug),
          )
        ) {
          await stream.writeSSE({ data: JSON.stringify(event) })
        }
      } catch (err) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'analysis failed',
          }),
        })
      }
    })
  })

  const kgProposals = new KgProposalStore()

  app.patch('/api/admin/tenants/:slug', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = renameTenantSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    tenants.patchBranding(config.slug, {
      productName: parsed.data.name,
      organisation: parsed.data.organisation,
      tagline: parsed.data.tagline,
    })
    return c.json({ ok: true })
  })

  app.post('/api/admin/t/:slug/kg/propose', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailableKg = requireManagement(c)
    if (unavailableKg) return unavailableKg
    try {
      const proposal = await proposeKgStrategy(management!, config)
      kgProposals.set(config.slug, proposal)
      return c.json(proposal)
    } catch (err) {
      return c.json({
        error: 'proposal_failed',
        message: err instanceof Error ? err.message : 'proposal failed',
      }, 502)
    }
  })

  app.post('/api/admin/t/:slug/kg/implement', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailableKgI = requireManagement(c)
    if (unavailableKgI) return unavailableKgI
    const proposal = kgProposals.get(config.slug)
    if (!proposal) return c.json({ error: 'no_proposal', message: 'Run Propose first.' }, 400)
    const parsed = kgImplementSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    return streamSSE(c, async (stream) => {
      for await (
        const event of implementKgStrategy(management!, config, proposal, {
          applyExisting: parsed.data.applyExisting,
          includeSummaries: parsed.data.includeSummaries ?? false,
        })
      ) {
        await stream.writeSSE({ data: JSON.stringify(event) })
      }
    })
  })

  app.get('/api/admin/t/:slug/agents', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailableAg = requireManagement(c)
    if (unavailableAg) return unavailableAg
    try {
      return c.json(await management!.listAgents(config))
    } catch {
      return c.json([])
    }
  })

  app.delete('/api/admin/t/:slug/agents/:taskId', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailableAd = requireManagement(c)
    if (unavailableAd) return unavailableAd
    await management!.deleteAgent(config, c.req.param('taskId'))
    return c.json({ ok: true })
  })

  app.post('/api/admin/t/:slug/branding/:kind', async (c) => {
    const config = tenant(c.req.param('slug'))
    const kind = c.req.param('kind')
    if (!config || (kind !== 'logo' && kind !== 'hero')) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const contentType = c.req.header('content-type') ?? ''
    const ext = contentType === 'image/png'
      ? 'png'
      : contentType === 'image/jpeg'
      ? 'jpg'
      : contentType === 'image/webp'
      ? 'webp'
      : contentType === 'image/svg+xml'
      ? 'svg'
      : null
    if (!ext) {
      return c.json({ error: 'unsupported_type', message: 'Use PNG, JPEG, WebP or SVG.' }, 415)
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.length === 0) return c.json({ error: 'empty_file' }, 400)
    if (bytes.length > 5 * 1024 * 1024) return c.json({ error: 'file_too_large' }, 413)
    mkdirSync(brandingDir, { recursive: true })
    // Drop any previous file for this slot so only one extension exists.
    for (const old of ['png', 'jpg', 'jpeg', 'webp', 'svg']) {
      const p = `${brandingDir}/${config.slug}-${kind}.${old}`
      if (existsSync(p)) {
        try {
          Deno.removeSync(p)
        } catch {
          // ignore
        }
      }
    }
    writeFileSync(`${brandingDir}/${config.slug}-${kind}.${ext}`, bytes)
    return c.json({ ok: true, url: `/api/t/${config.slug}/branding/${kind}` })
  })

  app.get('/api/admin/t/:slug/prompts', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(tenants.promptsFor(config.slug))
  })

  app.put('/api/admin/t/:slug/prompts', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = promptsSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    tenants.patch(config.slug, { prompts: { ask: parsed.data.ask?.trim() || undefined } })
    return c.json({ ok: true })
  })

  app.get('/api/admin/t/:slug/search-configs', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailableSc = requireManagement(c)
    if (unavailableSc) return unavailableSc
    return c.json(await management!.listSearchConfigs(config))
  })

  app.post('/api/admin/t/:slug/search-configs/ensure', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailableSe = requireManagement(c)
    if (unavailableSe) return unavailableSe
    const created = await management!.ensureSearchConfigs(config)
    return c.json({ ok: true, created })
  })

  app.get('/api/admin/t/:slug/crawl', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const url = c.req.query('url')
    if (!url) return c.json({ error: 'missing_url' }, 400)
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200)
    try {
      return c.json(await discoverLinks(url, limit))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'discovery failed'
      return c.json({ error: 'crawl_failed', message }, 400)
    }
  })

  app.post('/api/admin/t/:slug/labelsets', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailableLs = requireManagement(c)
    if (unavailableLs) return unavailableLs
    const parsed = labelsetBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    const id = parsed.data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (!id) return c.json({ error: 'invalid_request' }, 400)
    await management!.createLabelset(config, { id, ...parsed.data })
    return c.json({ ok: true, id })
  })

  app.get('/api/admin/t/:slug/insights', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(insights.summary(config.slug))
  })

  app.post('/api/admin/t/:slug/resources/:id/hidden', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const unavailable = requireManagement(c)
    if (unavailable) return unavailable
    const parsed = hiddenBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      await management!.setResourceHidden(config, c.req.param('id'), parsed.data.hidden)
    } catch (err) {
      // Boxes ship with the hidden-resources feature off - enable and retry.
      const message = err instanceof Error ? err.message : ''
      const kbId = bindings.get(config.slug)?.baseUrl.split('/kb/')[1]
      if (!/hidden resources enabled/i.test(message) || !kbId) throw err
      await enableHiddenResources(opts.zone ?? 'aws-ap-southeast-2-1', kbId)
      await management!.setResourceHidden(config, c.req.param('id'), parsed.data.hidden)
    }
    return c.json({ ok: true })
  })

  app.get('/api/admin/t/:slug/sources', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(sources.list(config.slug))
  })

  app.post('/api/admin/t/:slug/sources', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = sourceBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    return c.json(sources.add(config.slug, parsed.data.url, parsed.data.auto ?? true))
  })

  app.delete('/api/admin/t/:slug/sources/:id', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    sources.remove(config.slug, c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/admin/t/:slug/sources/:id/sync', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const source = sources.list(config.slug).find((s) => s.id === c.req.param('id'))
    if (!source) return c.json({ error: 'not_found' }, 404)
    if (!opts.management) return c.json({ error: 'management_unavailable' }, 503)
    const management = opts.management
    return streamSSE(c, async (stream) => {
      const emit = (event: unknown) => stream.writeSSE({ data: JSON.stringify(event) })
      try {
        const added = await syncSource(
          management,
          sources,
          config,
          source,
          (label) => emit({ type: 'item', label }),
        )
        await emit({ type: 'done', added })
      } catch (err) {
        await emit({ type: 'error', message: err instanceof Error ? err.message : 'sync_failed' })
      }
    })
  })

  app.post('/api/admin/migrate', async (c) => {
    const unavailable = requireManagement(c)
    if (unavailable) return unavailable
    const parsed = migrateBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    const from = tenant(parsed.data.from)
    const to = tenant(parsed.data.to)
    if (!from || !to || from.slug === to.slug) return c.json({ error: 'invalid_tenants' }, 400)
    return streamSSE(c, async (stream) => {
      const send = (event: MigrationEvent) => stream.writeSSE({ data: JSON.stringify(event) })
      try {
        const sources = await management!.listResources(from)
        await send({ type: 'start', total: sources.length })
        let copied = 0
        let skipped = 0
        let errors = 0
        for (const source of sources) {
          try {
            const full = await management!.resourceFull(from, source.id)
            const slug = full.slug ?? `mig-${source.id}`
            if (await management!.hasSlug(to, slug)) {
              skipped += 1
              await send({
                type: 'item',
                id: source.id,
                title: full.title,
                outcome: 'skipped-exists',
              })
              continue
            }
            if (full.kind === 'link' && full.originUrl) {
              await management!.createLink(to, { url: full.originUrl, title: full.title })
            } else if (full.texts.length > 0) {
              await management!.createText(to, {
                title: full.title,
                body: full.texts.map((t) => t.body).join('\n\n'),
                format: 'MARKDOWN',
                slug,
                topicId: full.topicIds[0],
                extraMetadata: full.extraMetadata,
              })
            } else {
              skipped += 1
              await send({
                type: 'item',
                id: source.id,
                title: full.title,
                outcome: 'skipped-unsupported',
                detail: 'Binary file without extracted text - re-upload it directly.',
              })
              continue
            }
            copied += 1
            await send({ type: 'item', id: source.id, title: full.title, outcome: 'copied' })
          } catch (err) {
            errors += 1
            await send({
              type: 'item',
              id: source.id,
              title: source.title,
              outcome: 'error',
              detail: err instanceof Error ? err.message.slice(0, 200) : 'failed',
            })
          }
        }
        await send({ type: 'done', copied, skipped, errors })
      } catch (err) {
        await send({
          type: 'error',
          message: err instanceof Error ? err.message : 'migration failed',
        })
      }
    })
  })

  app.post('/api/admin/t/:slug/knowledge-box', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const raw = await c.req.json().catch(() => null) as
      | { url?: unknown; token?: unknown }
      | null
    const parsed = connectBodySchema.safeParse(
      raw && typeof raw.url === 'string' && typeof raw.token === 'string'
        ? { url: raw.url.trim(), token: cleanToken(raw.token) }
        : raw,
    )
    if (!parsed.success) return c.json({ error: 'invalid_binding' }, 400)
    const target = parseKbUrl(parsed.data.url)
    if (!target) {
      return c.json({
        error: 'invalid_url',
        message: 'Enter the full knowledge box API endpoint - it should look like ' +
          'https://<region>.rag.progress.cloud/api/v1/kb/<box-id>.',
      }, 400)
    }
    const candidate = { baseUrl: target.baseUrl, token: parsed.data.token, kbId: target.kbId }
    const probe = new KbClient(candidate)
    let resourceCount = 0
    try {
      const counters = await probe.getJson<{ resources?: number }>('/counters')
      resourceCount = counters.resources ?? 0
    } catch (err) {
      const status = err instanceof AragApiError ? err.status : 0
      const text = err instanceof Error ? err.message : ''
      const message = status === 401 || status === 403 ||
          /jwt|decod|signature|unauthor|forbidden/i.test(text)
        ? 'The API key was not accepted - check it is the full service-account key ' +
          '(no Bearer prefix or quotes) and that it belongs to this box.'
        : status === 404
        ? 'The box was not found - check the URL ends with /api/v1/kb/<box-id> and the ' +
          'region is right.'
        : `Could not reach this knowledge box (${status || 'network error'}).`
      return c.json({ error: 'verification_failed', message }, 400)
    }
    bindings.set(config.slug, candidate)
    opts.invalidate?.(config.slug)
    return c.json({ ok: true, status: bindings.status(config.slug), resourceCount })
  })

  app.post('/api/t/:slug/ask', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = askBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_query' }, 400)
    return streamSSE(c, async (stream) => {
      const { query, ...askOpts } = parsed.data
      const settings = tenants.promptsFor(config.slug)
      // How the platform interpreted the question, surfaced when it lands in
      // time (first turn only - follow-ups depend on chat context).
      let interpreted: string | null | undefined
      if (!askOpts.context?.length && opts.management) {
        opts.management.rephrase(config, query).then((v) => interpreted = v, () => {})
      }
      let interpretedSent = false
      const record = {
        citations: 0,
        durationSec: null as number | null,
        answerRelevance: null as number | null,
        groundedness: null as number | null,
        contextRelevance: null as number | null,
        failed: false,
      }
      try {
        for await (
          const event of provider.ask(config, query, {
            ...askOpts,
            ...(settings.ask ? { systemPrompt: settings.ask } : {}),
            ...(settings.images ? { images: true } : {}),
          })
        ) {
          if (event.type === 'citation') record.citations += 1
          if (event.type === 'usage') record.durationSec = event.totalSec ?? null
          if (event.type === 'quality') {
            record.answerRelevance = event.answerRelevance
            record.groundedness = event.groundedness
            record.contextRelevance = event.contextRelevance
          }
          if (event.type === 'error') record.failed = true
          if (!interpretedSent && interpreted) {
            interpretedSent = true
            await stream.writeSSE({
              data: JSON.stringify({ type: 'interpreted', query: interpreted }),
            })
          }
          await stream.writeSSE({ data: JSON.stringify(event) })
        }
      } catch (err) {
        record.failed = true
        const message = err instanceof Error ? err.message : 'unknown_error'
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', message }) })
      }
      try {
        insights.record(config.slug, {
          ts: new Date().toISOString(),
          question: query.slice(0, 500),
          answered: !record.failed && record.citations > 0,
          citations: record.citations,
          durationSec: record.durationSec,
          answerRelevance: record.answerRelevance,
          groundedness: record.groundedness,
          contextRelevance: record.contextRelevance,
        })
      } catch {
        // insights are best-effort - never fail the answer over them
      }
    })
  })

  return app
}
