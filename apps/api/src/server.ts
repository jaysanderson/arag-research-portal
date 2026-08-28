import { serveStatic } from 'hono/deno'
import process from 'node:process'
import { AragProvider } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { BindingStore } from './bindings.ts'
import { SourceStore, WatchStore } from './stores.ts'
import { TenantStore } from './tenants.ts'
import { loadRootEnv } from './load-env.ts'
import { startScheduler } from './scheduler.ts'

loadRootEnv()

const port = Number(process.env.PORT ?? 8787)
const zone = process.env.ARAG_ZONE ?? 'aws-ap-southeast-2-1'

const bindings = new BindingStore()
const tenants = new TenantStore()
const provider = new AragProvider({ resolveBinding: (slug) => bindings.get(slug) })
// Constructed once and shared with startScheduler below - a scheduled sync
// and a concurrent HTTP write (e.g. POST /watches) must serialise through
// the same in-process store, not two separate instances racing to
// read-modify-write the same file (see the note on startScheduler).
const sources = new SourceStore()
const watches = new WatchStore()

const app = buildApp({
  provider,
  tenants,
  management: provider,
  bindings,
  sources,
  watches,
  zone,
  adminPasscode: process.env.ADMIN_PASSCODE,
  invalidate: (slug) => provider.invalidate(slug),
})

startScheduler(provider, tenants, sources, watches)

// Serve the built SPA (deno task build:web) alongside the API - one origin, no proxy.
app.use('*', serveStatic({ root: './apps/web/dist' }))
app.get('*', serveStatic({ path: './apps/web/dist/index.html' }))

Deno.serve({ port }, app.fetch)
