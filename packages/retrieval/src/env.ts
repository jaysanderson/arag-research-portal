import { AragProvider } from './providers/arag/index.ts'
import process from 'node:process'
import type { KbBinding } from './providers/arag/client.ts'

/**
 * Build the live Agentic RAG provider from environment variables.
 *
 * Required:
 *   ARAG_ZONE                 regional zone, e.g. aws-ap-southeast-2-1
 *   ARAG_KB_<SLUG>            knowledge box id for tenant <slug>
 *   ARAG_KB_<SLUG>_TOKEN      service-account token for that knowledge box
 *
 * Bindings are discovered by scanning the environment, so adding a tenant is
 * configuration, not code.
 */
export function createProviderFromEnv(env: Record<string, string | undefined> = process.env) {
  const zone = env.ARAG_ZONE
  if (!zone) {
    throw new Error('ARAG_ZONE is not set - copy .env.example to .env and fill it in')
  }
  const bindings: Record<string, KbBinding> = {}
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^ARAG_KB_([A-Z0-9]+)$/)
    if (!match?.[1] || !value) continue
    const slug = match[1].toLowerCase()
    const token = env[`ARAG_KB_${match[1]}_TOKEN`]
    if (token) bindings[slug] = { kbId: value, token }
  }
  if (Object.keys(bindings).length === 0) {
    throw new Error(
      'No knowledge box bindings found (ARAG_KB_<SLUG> + ARAG_KB_<SLUG>_TOKEN) - run: npm run provision',
    )
  }
  return new AragProvider({ zone, bindings })
}
