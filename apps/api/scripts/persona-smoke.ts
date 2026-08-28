/**
 * Post-deploy live persona smoke test.
 *
 * Runs the researcher persona's core journey against a LIVE, deployed
 * portal over plain HTTP - no mocking, no test doubles, real ARAG-backed
 * answers. For each configured tenant journey:
 *   1. Search returns at least one result for a known-good term.
 *   2. An in-corpus ask streams sources, is not refused, produces its
 *      first token within budget, and every `[n]` marker in the final
 *      answer text resolves to a citation the platform actually returned
 *      (the same claim-level grounding guarantee the UI relies on).
 *   3. An out-of-corpus ask IS refused - the portal must say "no direct
 *      evidence" rather than hallucinate an answer.
 *
 * A deploy that breaks any of this fails loudly, with a clear pass/fail
 * summary and a non-zero exit code, so it can gate the deploy workflow.
 *
 * Usage:
 *   BASE_URL=https://arag-research-portal.fly.dev \
 *     deno run --allow-net --allow-env apps/api/scripts/persona-smoke.ts [--quick]
 *
 * --quick checks a single tenant (2 LLM asks total: one in-corpus, one
 * out-of-corpus) instead of every tenant - the mode run after every deploy
 * to keep LLM spend sane. Omit --quick for the full multi-tenant sweep.
 */
import process from 'node:process'

interface TenantJourney {
  slug: string
  /** A broad term expected to match the tenant's real, ingested corpus. */
  searchTerm: string
  /** A question the corpus should be able to answer, cited. */
  goodAsk: string
  /** A question with no business being answerable from this corpus. */
  outOfCorpusAsk: string
}

const OUT_OF_CORPUS_ASK =
  'What is the capital of Mongolia, and how many Michelin-starred restaurants does it have?'

const ALL_TENANTS: TenantJourney[] = [
  {
    slug: 'frdc',
    searchTerm: 'fisheries',
    goodAsk: 'What stock assessment methods are recommended for data-limited fisheries?',
    outOfCorpusAsk: OUT_OF_CORPUS_ASK,
  },
  {
    slug: 'frdc-2',
    searchTerm: 'fisheries',
    goodAsk: 'What stock assessment methods are recommended for data-limited fisheries?',
    outOfCorpusAsk: OUT_OF_CORPUS_ASK,
  },
  {
    slug: 'grdc',
    searchTerm: 'grain',
    goodAsk: 'What are the best rotation strategies for managing herbicide-resistant ryegrass?',
    outOfCorpusAsk: OUT_OF_CORPUS_ASK,
  },
  {
    slug: 'gdrc',
    searchTerm: 'grain',
    goodAsk: 'What are the best rotation strategies for managing herbicide-resistant ryegrass?',
    outOfCorpusAsk: OUT_OF_CORPUS_ASK,
  },
]

// Which tenant slugs to actually exercise, in order. Overridable via
// PERSONA_SMOKE_TENANTS (comma-separated) so a deployment can point the smoke
// at the tenants that hold real content - the seeded demo slugs (frdc/grdc)
// differ from a live deployment's connected slugs (frdc-2/gdrc), and a tenant
// still being loaded with real content should not gate deploys until it is
// ready. Defaults to the code-seeded demo tenants for local/CI-double runs.
const TENANT_SLUGS = (Deno.env.get('PERSONA_SMOKE_TENANTS') ?? 'frdc,grdc')
  .split(',').map((s) => s.trim()).filter(Boolean)
const TENANTS: TenantJourney[] = TENANT_SLUGS
  .map((slug) => ALL_TENANTS.find((t) => t.slug === slug))
  .filter((t): t is TenantJourney => Boolean(t))

const FIRST_TOKEN_BUDGET_MS = 15_000
const ASK_TIMEOUT_MS = 60_000
/** Pause between successive asks - polite to the portal's per-IP rate limiter. */
const ASK_SPACING_MS = 4_000

type AskEventLike = Record<string, unknown> & { type?: unknown }

interface CheckResult {
  name: string
  pass: boolean
  detail: string
}

const results: CheckResult[] = []

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail })
  const label = pass ? 'PASS' : 'FAIL'
  console.log(`[${label}] ${name}${detail ? ` - ${detail}` : ''}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Parses a `text/event-stream` response body into its `data:` JSON payloads, in order. */
async function* sseEvents(response: Response): AsyncGenerator<AskEventLike> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() ?? ''
      for (const chunk of chunks) {
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw) continue
          try {
            yield JSON.parse(raw) as AskEventLike
          } catch {
            // A partial/malformed line - skip rather than abort the whole stream.
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function checkSearch(base: string, tenant: TenantJourney): Promise<void> {
  const name = `${tenant.slug}: search "${tenant.searchTerm}" returns results`
  try {
    const url = `${base}/api/t/${tenant.slug}/search?q=${encodeURIComponent(tenant.searchTerm)}`
    const res = await fetch(url)
    if (!res.ok) {
      record(name, false, `HTTP ${res.status}`)
      return
    }
    const body = await res.json() as { resources?: unknown[] }
    const count = Array.isArray(body.resources) ? body.resources.length : 0
    record(name, count > 0, `${count} result(s)`)
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err))
  }
}

interface AskOutcome {
  ok: boolean
  detail: string
}

/**
 * Streams one `/ask` and validates it against `expectRefused`: for an
 * in-corpus ask, sources must be non-empty, the answer not refused, the
 * first token within budget, and every `[n]` marker in the final text must
 * resolve to a citation the stream actually emitted; for an out-of-corpus
 * ask, the only requirement is that the platform honestly refuses.
 */
async function runAsk(
  base: string,
  tenant: TenantJourney,
  query: string,
  expectRefused: boolean,
): Promise<AskOutcome> {
  const start = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS)

  let firstTokenMs: number | null = null
  let sourcesCount = 0
  const citationIndices = new Set<number>()
  let refused = false
  let finalText = ''
  let streamedText = ''
  let sawDone = false
  let sawError: string | null = null

  try {
    const res = await fetch(`${base}/api/t/${tenant.slug}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    })
    if (!res.ok) {
      return { ok: false, detail: `HTTP ${res.status}` }
    }

    for await (const event of sseEvents(res)) {
      switch (event.type) {
        case 'sources': {
          const resources = event.resources
          if (Array.isArray(resources)) sourcesCount = Math.max(sourcesCount, resources.length)
          break
        }
        case 'delta': {
          if (firstTokenMs === null) firstTokenMs = performance.now() - start
          if (typeof event.text === 'string') streamedText += event.text
          break
        }
        case 'citation': {
          const citation = event.citation as { index?: unknown } | undefined
          if (citation && typeof citation.index === 'number') citationIndices.add(citation.index)
          break
        }
        case 'done': {
          sawDone = true
          refused = event.refused === true
          finalText = typeof event.text === 'string' ? event.text : streamedText
          break
        }
        case 'error': {
          sawError = typeof event.message === 'string' ? event.message : 'unknown error'
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    return {
      ok: false,
      detail: controller.signal.aborted
        ? `timed out after ${ASK_TIMEOUT_MS}ms`
        : err instanceof Error
        ? err.message
        : String(err),
    }
  } finally {
    clearTimeout(timeout)
  }

  if (!sawDone) {
    return {
      ok: false,
      detail: sawError ? `stream errored: ${sawError}` : 'stream ended without a done event',
    }
  }

  if (expectRefused) {
    return {
      ok: refused,
      detail: refused ? 'refused as expected' : 'expected a refusal but the portal answered',
    }
  }

  if (sawError) return { ok: false, detail: `stream errored: ${sawError}` }
  if (refused) return { ok: false, detail: 'the portal refused an in-corpus question' }
  if (sourcesCount === 0) return { ok: false, detail: 'no sources were returned' }
  if (firstTokenMs === null || firstTokenMs > FIRST_TOKEN_BUDGET_MS) {
    return {
      ok: false,
      detail:
        `first token took ${firstTokenMs === null ? 'n/a' : `${Math.round(firstTokenMs)}ms`} ` +
        `(budget ${FIRST_TOKEN_BUDGET_MS}ms)`,
    }
  }

  const markers = [...finalText.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
  const unresolved = markers.filter((n) => !citationIndices.has(n))
  if (citationIndices.size === 0) {
    return { ok: false, detail: 'no citations were returned for a grounded answer' }
  }
  if (unresolved.length > 0) {
    return {
      ok: false,
      detail: `marker(s) [${unresolved.join(', ')}] have no matching citation`,
    }
  }

  return {
    ok: true,
    detail: `sources=${sourcesCount}, citations=${citationIndices.size}, ` +
      `first token=${Math.round(firstTokenMs)}ms`,
  }
}

async function checkGoodAsk(base: string, tenant: TenantJourney): Promise<void> {
  const name = `${tenant.slug}: in-corpus ask streams a cited, grounded answer`
  const outcome = await runAsk(base, tenant, tenant.goodAsk, false)
  record(name, outcome.ok, outcome.detail)
}

async function checkRefusalAsk(base: string, tenant: TenantJourney): Promise<void> {
  const name = `${tenant.slug}: out-of-corpus ask is honestly refused`
  const outcome = await runAsk(base, tenant, tenant.outOfCorpusAsk, true)
  record(name, outcome.ok, outcome.detail)
}

async function main() {
  const base = (process.env.BASE_URL ?? '').replace(/\/+$/, '')
  if (!base) {
    console.error('Missing BASE_URL - e.g. BASE_URL=https://arag-research-portal.fly.dev')
    process.exit(1)
  }
  const quick = Deno.args.includes('--quick')
  const tenants = quick ? TENANTS.slice(0, 1) : TENANTS

  console.log(`Persona smoke test against ${base}${quick ? ' (quick mode)' : ''}`)
  console.log(`Tenants: ${tenants.map((t) => t.slug).join(', ')}\n`)

  for (const [index, tenant] of tenants.entries()) {
    if (index > 0) await sleep(ASK_SPACING_MS)

    await checkSearch(base, tenant)
    await sleep(ASK_SPACING_MS)
    await checkGoodAsk(base, tenant)
    await sleep(ASK_SPACING_MS)
    await checkRefusalAsk(base, tenant)
  }

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`)
  if (failed.length > 0) {
    console.log('\nFailures:')
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
    process.exit(1)
  }
  console.log('All persona journeys are healthy.')
}

await main()
