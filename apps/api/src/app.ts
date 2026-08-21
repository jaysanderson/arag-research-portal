import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import type { TenantConfig } from '@research-portal/core'
import type { RetrievalProvider } from '@research-portal/retrieval'
import { tenantConfig, tenantSummaries } from './tenants.ts'

const searchQuerySchema = z.object({ q: z.string().min(1) })
const askBodySchema = z.object({ query: z.string().min(1) })

export function buildApp(opts: { provider: RetrievalProvider }): Hono {
  const { provider } = opts
  const app = new Hono()

  app.use('/api/*', cors({ origin: (origin) => origin }))

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
