import { serveStatic } from 'hono/deno'
import process from 'node:process'
import { createProviderFromEnv } from '@research-portal/retrieval'
import { buildApp } from './app.ts'
import { loadRootEnv } from './load-env.ts'

loadRootEnv()

const port = Number(process.env.PORT ?? 8787)

const app = buildApp({ provider: createProviderFromEnv() })

// Serve the built SPA (deno task build:web) alongside the API - one origin, no proxy.
app.use('*', serveStatic({ root: './apps/web/dist' }))
app.get('*', serveStatic({ path: './apps/web/dist/index.html' }))

Deno.serve({ port }, app.fetch)
