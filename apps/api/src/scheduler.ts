import type { TenantConfig } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'
import { discoverLinks } from './crawl.ts'
import { type Source, SourceStore, WatchStore } from './stores.ts'
import type { TenantStore } from './tenants.ts'

// ---------------------------------------------------------------------------
// Background upkeep: re-sync registered sources (ingest pages that appeared
// since the last sync) and re-run saved-search watches so users see a
// "results changed" badge. Runs daily on the server; each source can also be
// synced on demand from Manage > Content.
// ---------------------------------------------------------------------------

const SYNC_CAP = 60

/** Ingest new pages from one source; returns how many were added. */
export async function syncSource(
  management: AragProvider,
  sources: SourceStore,
  config: TenantConfig,
  source: Source,
  emit: (label: string) => void | Promise<void>,
): Promise<number> {
  const discovered = await discoverLinks(source.url, SYNC_CAP)
  const known = new Set(source.synced ?? [])
  const fresh = discovered.links.filter((l) => !known.has(l))
  await emit(
    `Found ${discovered.links.length} pages via ${discovered.source} - ${fresh.length} new`,
  )
  let added = 0
  for (const url of fresh) {
    try {
      await management.createLink(config, { url })
      known.add(url)
      added += 1
      if (added % 5 === 0) await emit(`Ingested ${added} of ${fresh.length} new pages...`)
    } catch {
      await emit(`Skipped ${url} - the platform rejected it`)
    }
  }
  sources.update(config.slug, source.id, {
    lastSync: new Date().toISOString(),
    lastAdded: added,
    synced: [...known].slice(-2000),
  })
  await emit(added > 0 ? `Sync complete - ${added} pages added` : 'Sync complete - nothing new')
  return added
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

/** Start the daily upkeep timer; returns a stop function. */
export function startScheduler(
  management: AragProvider,
  tenants: TenantStore,
): () => void {
  const sources = new SourceStore()
  const watches = new WatchStore()
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
