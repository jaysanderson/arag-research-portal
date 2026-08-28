import { serveStatic } from 'hono/deno'
import { readFileSync } from 'node:fs'
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
// Cache-bust the entry bundle so a deploy is never masked by a stale copy in the
// browser: the versioned ?v=<sha> asset URLs change every release, and the HTML
// itself is served no-cache so it always revalidates and hands out the new URLs.
const buildSha = process.env.BUILD_SHA ?? 'dev'
let indexHtml = ''
try {
  indexHtml = readFileSync('./apps/web/dist/index.html', 'utf8')
    .replace('"/app.js"', `"/app.js?v=${buildSha}"`)
    .replace('"/styles.css"', `"/styles.css?v=${buildSha}"`)
} catch {
  // No build present (e.g. a dev server before build:web) - the health check
  // reports web:false and the catch-all below returns 503.
  indexHtml = ''
}

app.use('*', serveStatic({ root: './apps/web/dist' }))
app.get('*', (c) => {
  if (!indexHtml) return c.text('The web build is not available.', 503)
  c.header('Cache-Control', 'no-cache')
  return c.html(indexHtml)
})

Deno.serve({ port }, app.fetch)
