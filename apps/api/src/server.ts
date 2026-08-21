import { serveStatic } from 'hono/deno'
import process from 'node:process'
import { AragProvider } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { BindingStore } from './bindings.ts'
import { loadRootEnv } from './load-env.ts'

loadRootEnv()

const port = Number(process.env.PORT ?? 8787)
const zone = process.env.ARAG_ZONE ?? 'aws-ap-southeast-2-1'

const bindings = new BindingStore()
const provider = new AragProvider({ zone, resolveBinding: (slug) => bindings.get(slug) })

const app = buildApp({
  provider,
  management: provider,
  bindings,
  zone,
  adminPasscode: process.env.ADMIN_PASSCODE,
  invalidate: (slug) => provider.invalidate(slug),
})

// Serve the built SPA (deno task build:web) alongside the API - one origin, no proxy.
app.use('*', serveStatic({ root: './apps/web/dist' }))
app.get('*', serveStatic({ path: './apps/web/dist/index.html' }))

Deno.serve({ port }, app.fetch)
