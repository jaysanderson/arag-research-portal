import type { TenantConfig } from '@research-portal/core'
import { AragApiError, type AragProvider } from '@research-portal/retrieval'
import { discoverLinks, extractMainContent, looksLikeChallengePage } from './crawl.ts'
import { type Source, SourceStore, WatchStore } from './stores.ts'
import type { TenantStore } from './tenants.ts'

// ---------------------------------------------------------------------------
// Background upkeep: re-sync registered sources (ingest pages that appeared
// since the last sync) and re-run saved-search watches so users see a
// "results changed" badge. Runs daily on the server; each source can also be
// synced on demand from Manage > Content.
// ---------------------------------------------------------------------------

/** Pages discovered per crawl - deep enough to reach past already-synced ones. */
const DISCOVER_CAP = 500
/** New pages ingested per sync run - the rest arrive on later runs. */
const SYNC_CAP = 60

/** Ingest new pages from one source; reports how many were added vs left for next time. */
export async function syncSource(
  management: AragProvider,
  sources: SourceStore,
  config: TenantConfig,
  source: Source,
  emit: (label: string) => void | Promise<void>,
): Promise<{ added: number; deferred: number }> {
  const discovered = await discoverLinks(source.url, DISCOVER_CAP)
  const known = new Set(source.synced ?? [])
  const freshAll = discovered.links.filter((l) => !known.has(l))
  const fresh = freshAll.slice(0, SYNC_CAP)
  await emit(
    `Found ${discovered.links.length} pages via ${discovered.source} - ${freshAll.length} new` +
      (freshAll.length > fresh.length ? ` (ingesting ${fresh.length} this run)` : ''),
  )
  let added = 0
  let rejected = 0
  let deferred = 0
  for (const [i, url] of fresh.entries()) {
    try {
      // Fetch and clean the page ourselves so the index holds body content,
      // not nav chrome - and so bot walls never enter the corpus.
      let ingested = false
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': 'Mozilla/5.0 (research-portal-ingest)' },
          signal: AbortSignal.timeout(25_000),
        })
        if (res.ok && (res.headers.get('content-type') ?? '').includes('html')) {
          const html = await res.text()
          const cleaned = extractMainContent(html)
          if (cleaned) {
            await management.createText(config, {
              title: cleaned.title,
              body: cleaned.body,
              format: 'MARKDOWN',
              originUrl: url,
            })
            ingested = true
          } else if (looksLikeChallengePage(html)) {
            rejected += 1
            known.add(url)
            continue
          }
        }
      } catch (err) {
        // A knowledge-box back-pressure error is not a fetch failure - let it
        // through to the outer catch rather than masking it as a crawler fallback.
        if (err instanceof AragApiError && err.backpressure) throw err
        // fall through to the platform crawler
      }
      if (!ingested) {
        await management.createLink(config, { url })
      }
      known.add(url)
      added += 1
      if (added % 5 === 0) await emit(`Ingested ${added} of ${fresh.length} new pages…`)
    } catch (err) {
      if (err instanceof AragApiError && err.backpressure) {
        // The box's ingestion queue is full. Stop this run cleanly rather
        // than hammering it for every remaining page - they stay un-synced
        // (not added to `known`) so the next scheduled or manual sync picks
        // them up once the queue has drained.
        deferred = fresh.length - i
        await emit(
          `Knowledge box is busy processing recent changes - stopping this run early. ` +
            `${deferred} ${deferred === 1 ? 'page' : 'pages'} left for the next sync.`,
        )
        break
      }
      await emit(`Skipped ${url} - the platform rejected it`)
    }
  }
  if (rejected > 0) {
    await emit(`Rejected ${rejected} bot-challenge or empty ${rejected === 1 ? 'page' : 'pages'}`)
  }
  sources.update(config.slug, source.id, {
    lastSync: new Date().toISOString(),
    lastAdded: added,
    synced: [...known].slice(-5000),
  })
  await emit(added > 0 ? `Sync complete - ${added} pages added` : 'Sync complete - nothing new')
  return { added, deferred }
}

/** Re-run every watch and flag the ones whose top results changed. */
export async function runWatches(
  management: AragProvider,
  tenants: TenantStore,
  watches: WatchStore,
): Promise<void> {
  for (const summary of tenants.list()) {
    const config = tenants.get(summary.slug)
    if (!config) continue
    for (const watch of watches.list(config.slug)) {
      try {
        const results = await management.search(config, watch.query, {
          mode: 'hybrid',
          pageSize: 10,
        })
        const fingerprint = results.resources.map((r) => r.id).sort().join('|')
        watches.update(config.slug, watch.id, {
          lastRun: new Date().toISOString(),
          fingerprint,
          // Only flag change once a baseline exists - the first run is setup.
          changed: watch.changed ||
            (watch.fingerprint !== null && watch.fingerprint !== fingerprint),
        })
      } catch {
        // box offline or rebinding - try again next cycle
      }
    }
  }
}

/** Sync every auto source across all portals (daily job). */
export async function runAutoSyncs(
  management: AragProvider,
  tenants: TenantStore,
  sources: SourceStore,
): Promise<void> {
  for (const summary of tenants.list()) {
    const config = tenants.get(summary.slug)
    if (!config) continue
    for (const source of sources.list(config.slug)) {
      if (!source.auto) continue
      try {
        await syncSource(management, sources, config, source, () => {})
      } catch {
        // source site unreachable - try again next cycle
      }
    }
  }
}

/**
 * Start the daily upkeep timer; returns a stop function.
 *
 * `sources` and `watches` must be the SAME store instances buildApp uses for
 * its HTTP routes (POST /watches, the sources admin endpoints), not fresh
 * ones. Both stores do a whole-file read-modify-write on each mutation,
 * so a scheduled sync and a concurrent HTTP write against two separate
 * instances can each read the file before the other's write lands and
 * silently drop it. Sharing instances doesn't remove that race by itself,
 * but it keeps both writers serialised through one in-process object
 * instead of racing through the filesystem via two.
 */
export function startScheduler(
  management: AragProvider,
  tenants: TenantStore,
  sources: SourceStore,
  watches: WatchStore,
): () => void {
  const run = async () => {
    await runAutoSyncs(management, tenants, sources).catch(() => {})
    await runWatches(management, tenants, watches).catch(() => {})
  }
  // First pass shortly after boot (machines may sleep between requests), then daily.
  const boot = setTimeout(() => run(), 90_000)
  const daily = setInterval(() => run(), 24 * 3600 * 1000)
  return () => {
    clearTimeout(boot)
    clearInterval(daily)
  }
}
