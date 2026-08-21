import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { TenantConfig } from '@research-portal/core'
import {
  KbClient,
  KnowledgeBoxNotConnectedError,
  type RetrievalProvider,
} from '@research-portal/retrieval'
import { tenantConfig, tenantSummaries } from './tenants.ts'
import { BindingStore } from './bindings.ts'

const searchQuerySchema = z.object({ q: z.string().min(1) })
const askBodySchema = z.object({ query: z.string().min(1) })
const connectBodySchema = z.object({
  kbId: z.string().min(8),
  token: z.string().min(20),
})

export interface BuildAppOptions {
  provider: RetrievalProvider
  bindings?: BindingStore
  zone?: string
  adminPasscode?: string
  /** Called after a tenant is rebound so the provider can drop its caches. */
  invalidate?: (slug: string) => void
}

export function buildApp(opts: BuildAppOptions): Hono {
  const { provider } = opts
  const bindings = opts.bindings ?? new BindingStore({})
  const app = new Hono()

  app.use('/api/*', cors({ origin: (origin) => origin }))

  app.onError((err, c) => {
    if (err instanceof KnowledgeBoxNotConnectedError) {
      return c.json({ error: 'knowledge_box_not_connected', slug: err.slug }, 503)
    }
    console.error(err)
    return c.json({ error: 'internal_error' }, 500)
  })

  const tenant = (slug: string): TenantConfig | undefined => tenantConfig(slug)

  app.get('/api/tenants', (c) => c.json(tenantSummaries()))

  app.get('/api/t/:slug/config', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(config)
  })

  app.get('/api/t/:slug/search', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = searchQuerySchema.safeParse({ q: c.req.query('q') })
    if (!parsed.success) return c.json({ error: 'missing_query' }, 400)
    return c.json(await provider.search(config, parsed.data.q))
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

  app.get('/api/t/:slug/knowledge-box', (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    return c.json(bindings.status(config.slug))
  })

  // Admin: connect a knowledge box to a tenant. The administrator enters the
  // KB id and service-account token in the app; both stay server-side. When
  // ADMIN_PASSCODE is configured every admin call must present it.
  app.use('/api/admin/*', async (c, next) => {
    if (opts.adminPasscode && c.req.header('x-admin-passcode') !== opts.adminPasscode) {
      return c.json({ error: 'unauthorised' }, 401)
    }
    await next()
  })

  app.post('/api/admin/t/:slug/knowledge-box', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = connectBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_binding' }, 400)
    const zone = opts.zone ?? 'aws-ap-southeast-2-1'
    const probe = new KbClient(zone, parsed.data)
    let resourceCount = 0
    try {
      const catalog = await probe.getJson<{ resources?: Record<string, unknown> }>(
        '/catalog?page=0&size=100',
      )
      resourceCount = Object.keys(catalog.resources ?? {}).length
    } catch (err) {
      const message = err instanceof Error ? err.message : 'verification failed'
      return c.json({ error: 'verification_failed', message }, 400)
    }
    bindings.set(config.slug, parsed.data)
    opts.invalidate?.(config.slug)
    return c.json({ ok: true, status: bindings.status(config.slug), resourceCount })
  })

  app.post('/api/t/:slug/ask', async (c) => {
    const config = tenant(c.req.param('slug'))
    if (!config) return c.json({ error: 'unknown_tenant' }, 404)
    const parsed = askBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_query' }, 400)
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of provider.ask(config, parsed.data.query)) {
          await stream.writeSSE({ data: JSON.stringify(event) })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown_error'
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', message }) })
      }
    })
  })

  return app
}
