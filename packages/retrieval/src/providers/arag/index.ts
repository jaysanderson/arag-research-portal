import type {
  AskEvent,
  CatalogItem,
  CatalogPage,
  FacetCounts,
  GraphData,
  KbAgent,
  KbCounters,
  Labelset,
  Question,
  RecentResource,
  ResourceContent,
  ResourceSummary,
  ResourceType,
  ScoredResource,
  SearchResults,
  TenantConfig,
} from '@research-portal/core'
import { ResourceSummarySchema } from '@research-portal/core'
import type {
  AskOptions,
  CatalogOptions,
  RetrievalProvider,
  SearchOptions,
} from '../../provider.ts'
import { baselineMerchandising, extractPageSummary } from '../../merchandise.ts'
import { AragApiError, type KbBinding, KbClient, ndjson } from './client.ts'
import { spliceCitationMarkers, stripInlineMarkers } from './citations.ts'

const CATALOG_TTL_MS = 60_000
/** Catalogue paging: 200 per call, up to 40 calls - 8,000 resources. */
const CATALOG_PAGE_SIZE = 200
const CATALOG_MAX_PAGES = 40
/** Health scan reads full text per resource - sample the newest slice. */
const HEALTH_SCAN_LIMIT = 400
const HEALTH_SCAN_CONCURRENCY = 12
/** Bounded delete concurrency for `purgeFailedResources` - never hammer the box. */
const PURGE_DELETE_CONCURRENCY = 5
/** Dry-run/confirmation sample size for `purgeFailedResources`. */
const PURGE_SAMPLE_SIZE = 20
/** Extra attempts (beyond the first) for an ingestion call that hits back-pressure. */
const BACKPRESSURE_MAX_RETRIES = 2
/** Never let one request wait longer than this for the platform's queue to clear. */
const BACKPRESSURE_MAX_WAIT_MS = 20_000
/** Floor for the wait even when try_after is already in the past. */
const BACKPRESSURE_MIN_WAIT_MS = 1_000

/**
 * Retry a single ingestion write (createText/createLink) across the
 * platform's ingestion back-pressure (HTTP 429, `back_pressure_type`
 * present). Honours the server's `try_after` hint, capped so one request
 * never hangs indefinitely. Any other error - or back-pressure that is still
 * present after the retry budget - is rethrown as-is (a typed AragApiError
 * with `.backpressure` set, for the caller to distinguish from a hard
 * failure).
 */
async function withBackpressureRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0;; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const backpressure = err instanceof AragApiError ? err.backpressure : null
      if (!backpressure || attempt >= BACKPRESSURE_MAX_RETRIES) throw err
      const waitMs = Math.min(
        Math.max(backpressure.tryAfter * 1000 - Date.now(), BACKPRESSURE_MIN_WAIT_MS),
        BACKPRESSURE_MAX_WAIT_MS,
      )
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
}

/**
 * Reference-list / front-matter heuristic: bibliography chunks match query
 * strings through citation TITLES and masquerade as high-scoring evidence.
 * Dense author-year patterns, DOIs and "References" headers give them away.
 */
export function looksLikeReferenceChunk(text: string): boolean {
  const sample = text.slice(0, 1200)
  const authorYear = (sample.match(/\(\s*(19|20)\d{2}[a-z]?\s*\)|,\s*(19|20)\d{2}[.,)]/g) ?? [])
    .length
  const dois = (sample.match(/doi\.org|10\.\d{4,}\//gi) ?? []).length
  const etAl = (sample.match(/et al\.?/gi) ?? []).length
  const headerHit = /^(#+\s*)?(references|bibliography|works cited|further reading)\b/im.test(
    sample,
  )
  const frontMatter =
    /ISBN|ISSN|all rights reserved|copyright ©|creative commons|this publication (may|should) be cited/i
      .test(sample)
  const words = sample.split(/\s+/).length || 1
  const density = (authorYear + dois + etAl) / (words / 100)
  return headerHit || frontMatter || density > 2.5 || (authorYear >= 4 && etAl >= 2)
}

/**
 * Raw platform id/hash rather than a human title - the shape a resource's
 * internal identifier takes when title extraction failed and the id leaked
 * through as the display title (e.g. a bare 32-char hex uuid). Requires both
 * a letter and a digit so ordinary short codes and numeric strings never
 * false-positive.
 */
export function looksLikeRawHashTitle(value: string): boolean {
  const v = value.trim()
  if (!v || v.includes(' ')) return false
  return /^[a-f0-9-]{20,64}$/i.test(v) && /[a-f]/i.test(v) && /\d/.test(v)
}

/** Known bot-challenge page titles that must never surface as a resource label. */
export function looksLikeBotChallengeTitle(value: string): boolean {
  return /(just a moment\s*\.{0,3}$|attention required|please verify you are human|enable javascript and cookies to continue)/i
    .test(value.trim())
}

/**
 * System/housekeeping file names that are never a real document - a dotfile
 * (`.uploaded.log`, `.DS_Store`) or a log/temp/backup artefact that slipped
 * into the box during ingestion. These must never surface in a user-facing
 * list or as a "related" recommendation.
 */
export function looksLikeSystemFileTitle(value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (v.startsWith('.')) return true
  return /\.(log|tmp|temp|bak|swp|ds_store)$/i.test(v)
}

/** Office/OpenDocument mime types the browser cannot render natively. */
export function isOfficeMime(mime: string | undefined): boolean {
  if (!mime) return false
  const m = mime.toLowerCase()
  return m.includes('officedocument') || // .docx/.pptx/.xlsx (OpenXML)
    m.includes('msword') || m.includes('ms-powerpoint') || m.includes('ms-excel') ||
    m.includes('vnd.oasis.opendocument') // .odt/.odp/.ods
}

/**
 * The viewer kind for a resource, derived from every mime hint the platform
 * gives (its `icon` plus the content-type of any attached file field), not
 * `icon` alone - a scanned/older PDF whose `icon` never populated still
 * renders as a PDF when its file field reports `application/pdf`. Pure and
 * order-sensitive (PDF/media/image win over the generic `file`/`office`
 * fallbacks); shared by `resourceContent` and its tests.
 */
export function detectContentKind(
  input: { icon: string; isLink: boolean; fileMimes: string[] },
): 'web' | 'pdf' | 'video' | 'audio' | 'image' | 'office' | 'text' | 'file' {
  if (input.isLink) return 'web'
  const mimes = [input.icon, ...input.fileMimes]
    .map((m) => (m ?? '').toLowerCase())
    .filter((m) => m.length > 0)
  const has = (pred: (m: string) => boolean) => mimes.some(pred)
  if (has((m) => m === 'application/pdf' || m.endsWith('/pdf'))) return 'pdf'
  if (has((m) => m.startsWith('video/'))) return 'video'
  if (has((m) => m.startsWith('audio/'))) return 'audio'
  if (has((m) => m.startsWith('image/'))) return 'image'
  if (has((m) => isOfficeMime(m))) return 'office'
  return input.fileMimes.length > 0 ? 'file' : 'text'
}

/**
 * A renderable stand-in for an original the browser can't display (an Office
 * document), when the platform generated one: a PDF or image rendition among
 * the resource's file fields, distinct from the primary Office file itself.
 * Returns nothing when no such rendition exists - the caller then falls back
 * to the honest thumbnail + download panel rather than pretending.
 */
export function selectPreviewFile(
  files: { fieldId: string; contentType?: string }[],
  primaryFieldId: string | undefined,
): { fieldId: string; contentType?: string } | undefined {
  return files.find((f) =>
    f.fieldId !== primaryFieldId &&
    (f.contentType === 'application/pdf' || (f.contentType ?? '').startsWith('image/'))
  )
}

/**
 * A resource's best available human title, never a raw platform id/hash and
 * never a bot-challenge string. Falls back to a clean, generic label rather
 * than the id itself - a bare FRDC-style project code is fine to show as-is,
 * it just isn't a hash.
 */
export function displayTitle(rawTitle: string | undefined, _id: string): string {
  const trimmed = (rawTitle ?? '').trim()
  if (trimmed && !looksLikeRawHashTitle(trimmed) && !looksLikeBotChallengeTitle(trimmed)) {
    return trimmed
  }
  return 'Untitled resource'
}

/** The shape `isDisplayableResource` needs from a raw platform resource. */
export interface DisplayabilityInput {
  title?: string
  metadata?: { status?: string }
}

/**
 * Whether a resource belongs in a user-facing list (catalog, library,
 * search, typeahead). Failed ingests (status ERROR) and junk titles - a raw
 * platform hash where title extraction failed, or a bot-challenge page that
 * slipped through ingestion - are hidden from every user-facing surface.
 * Admin/corpus-health surfaces read the platform's raw catalogue directly
 * and never call this, so curators still see everything that needs fixing.
 */
export function isDisplayableResource(raw: DisplayabilityInput): boolean {
  if ((raw.metadata?.status ?? '').toUpperCase() === 'ERROR') return false
  const title = (raw.title ?? '').trim()
  if (looksLikeRawHashTitle(title)) return false
  if (looksLikeBotChallengeTitle(title)) return false
  if (looksLikeSystemFileTitle(title)) return false
  return true
}

/**
 * Eligibility for `purgeFailedResources`'s PERMANENT delete - deliberately
 * much narrower than `isDisplayableResource` (which merely hides a resource
 * from user-facing lists; nothing there is destructive). A resource is
 * eligible only if:
 *  - its title is a known bot-challenge string (a crawl that "succeeded" but
 *    only captured a Cloudflare/bot-wall page as its content), OR
 *  - its ingest failed outright (status ERROR) AND it never got any title at
 *    all.
 * A raw hash title (title extraction failed but the underlying document may
 * be real) is NEVER eligible on its own, even under an ERROR status, and
 * NEITHER is any other genuine human title, even under an ERROR status - an
 * error with a real title may be a real document that just needs
 * re-ingesting, not deleting. If in doubt, this returns false; deletion is
 * irreversible.
 */
export function isPurgeEligible(raw: DisplayabilityInput): boolean {
  const title = (raw.title ?? '').trim()
  if (looksLikeBotChallengeTitle(title)) return true
  const isError = (raw.metadata?.status ?? '').toUpperCase() === 'ERROR'
  return isError && title === ''
}

/**
 * Relevance floor for structured generation's grounding gate: a calibrated
 * retrieval score below this is noise, not evidence - the same floor
 * `search`'s MIN_SCORE already applies to /find results. Kept as its own
 * constant because generate's grounding decision is a policy choice
 * independent of search's, even though today the two agree.
 */
export const MIN_GENERATE_GROUNDING = 0.1

/**
 * Refusal-override floor for `ask`: a known platform quirk (see
 * docs/ARAG-DEV.md) has Nuclia's default guardrail sentence ("Not enough
 * data to answer this.") fire even when the system prompt explicitly forbids
 * it and genuinely relevant material was retrieved - this is the inconsistent
 * refusal a rephrased question sails past. When a retrieved source clears
 * this bar, one retry with a firmer directive runs before an honest refusal
 * is accepted (see `ask`). Set well above the search/grounding noise floor
 * (`MIN_GENERATE_GROUNDING`, 0.1) so a genuinely out-of-corpus question -
 * which retrieves nothing this relevant - is never talked out of refusing.
 */
export const MIN_REFUSAL_OVERRIDE_RELEVANCE = 0.3

/** Nuclia's default guardrail sentence - see MIN_REFUSAL_OVERRIDE_RELEVANCE above. */
export const REFUSAL_TEXT = 'not enough data to answer this.'

/**
 * Whether `text` IS (or reduces to) the platform's bare guardrail refusal
 * sentence, tolerant of the incidental noise a real streamed response can
 * carry around it - surrounding whitespace/newlines (including non-breaking
 * space, which the platform has been seen to emit), wrapping quote marks, or
 * a missing trailing period. This is the single source of truth for "was
 * this call refused" - `ask`'s retry gates and its final refused/done.text
 * decision all read through it, so they can never disagree with each other
 * (see BUG 2: a prior ad hoc, streaming-only prefix check could diverge from
 * what the client was ultimately shown, letting a bare guardrail sentence
 * through as if it were a real, cited answer).
 */
export function isGuardrailRefusal(text: string): boolean {
  const normalised = text
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^['"“”]+|['"“”]+$/g, '')
    .trim()
  if (!normalised) return false
  return normalised === REFUSAL_TEXT || normalised === REFUSAL_TEXT.replace(/\.$/, '')
}

/**
 * Calibrates a raw retrieval score to [0, 1], comparable across queries:
 * semantic scores are already 0-1; BM25 scores (>1) are squashed
 * logistically. Never normalised to the top hit - a weak match must LOOK
 * weak. `search` and `ask` each apply an equivalent formula inline; factored
 * out here so structured generation's grounding gate agrees with them by
 * construction rather than by three implementations happening to match.
 */
export function calibrateRelevance(score: number): number {
  return score <= 1 ? Math.max(0, Math.min(1, score)) : score / (score + 2)
}

/**
 * Best-scoring paragraph match for one retrieval hit, and whether it looks
 * like reference-list/front-matter noise (downweighted, same heuristic
 * `search` and `ask` use via `looksLikeReferenceChunk`). Shared scoring pass
 * so structured generation's grounding gate judges a source's relevance the
 * same way `ask` scores its grounding sources.
 */
function bestParagraphMatch(raw: {
  fields?: Record<
    string,
    {
      paragraphs?: Record<
        string,
        { score?: number; text?: string; position?: { page_number?: number } }
      >
    }
  >
}): { best: number; passage?: string; page?: number; reference: boolean } {
  let best = 0
  let passage: string | undefined
  let page: number | undefined
  for (const field of Object.values(raw.fields ?? {})) {
    for (const paragraph of Object.values(field.paragraphs ?? {})) {
      const score = paragraph.score ?? 0
      if (score >= best) {
        best = score
        passage = paragraph.text ?? passage
        page = paragraph.position?.page_number
      }
    }
  }
  const reference = passage ? looksLikeReferenceChunk(passage) : false
  return { best: reference ? best * 0.4 : best, passage, page, reference }
}

/** The extra.metadata payload the provisioning script stores on every resource. */
interface PortalMetadata {
  summary?: string
  keyFacts?: string[]
  topic?: string
  type?: string
  published?: string
}

interface RawResource {
  id?: string
  title?: string
  summary?: string
  created?: string
  usermetadata?: { classifications?: { labelset?: string; label?: string }[] }
  /**
   * Platform-computed metadata (DA classifier output etc). NucliaDB's own
   * shape carries computed labels per-field here rather than in
   * `usermetadata` (which is reserved for user-applied ones), and/or a
   * top-level `classifications` fallback on some deployments - see
   * `classificationLabels` below and the final report's probe notes for what
   * was and wasn't confirmed live on this box.
   */
  computedmetadata?: {
    field_classifications?: {
      classifications?: { labelset?: string; label?: string; cancelled_by_user?: boolean }[]
    }[]
    classifications?: { labelset?: string; label?: string; cancelled_by_user?: boolean }[]
  }
  extra?: { metadata?: PortalMetadata }
  metadata?: { status?: string }
}

/**
 * A raw resource's labels for one labelset - user-applied
 * (`usermetadata.classifications`) union platform-computed
 * (`computedmetadata`), deduplicated. Shared by `catalogItemFromRaw` and
 * `toSummary` so every user-facing surface picks up computed (DA classifier)
 * labels the moment the platform includes them in a payload, with no further
 * code change. A computed label the user has since removed
 * (`cancelled_by_user: true`) is excluded.
 */
function classificationLabels(raw: RawResource, labelset: string): string[] {
  const labels = new Set<string>()
  for (const c of raw.usermetadata?.classifications ?? []) {
    if (c.labelset === labelset && c.label) labels.add(c.label)
  }
  for (const field of raw.computedmetadata?.field_classifications ?? []) {
    for (const c of field.classifications ?? []) {
      if (c.labelset === labelset && c.label && !c.cancelled_by_user) labels.add(c.label)
    }
  }
  for (const c of raw.computedmetadata?.classifications ?? []) {
    if (c.labelset === labelset && c.label && !c.cancelled_by_user) labels.add(c.label)
  }
  return [...labels]
}

/** Shape of a /find response's resources map - shared by `search` and `catalogByQuery`. */
type FindResponse = {
  resources?: Record<
    string,
    RawResource & {
      fields?: Record<string, { paragraphs?: Record<string, { score?: number; text?: string }> }>
    }
  >
}

/** Builds a CatalogItem from a raw platform resource - shared by catalogue's paged browse and its filtered-query path, so both render the same shape. */
function catalogItemFromRaw(id: string, r: RawResource): CatalogItem {
  const status = r.metadata?.status
  const safe = displayTitle(r.title, id)
  const rawTitle = safe === 'Untitled resource' ? '' : (r.title ?? '')
  const merch = baselineMerchandising(rawTitle, r.summary ?? r.extra?.metadata?.summary)
  return {
    id,
    title: merch.title,
    status: status === 'PROCESSED' ? 'processed' : status === 'ERROR' ? 'error' : 'pending',
    created: r.created,
    topicIds: classificationLabels(r, 'topic'),
    kind: classificationLabels(r, 'kind')[0],
    published: r.extra?.metadata?.published,
    ...(merch.sourceName ? { sourceName: merch.sourceName } : {}),
    enriched: false,
  }
}

/**
 * Words too generic to signal a real topic match between a query and a
 * suggested question - question scaffolding ("what", "does", "about"), not
 * subject matter.
 */
const RELATED_QUESTION_STOPWORDS = new Set([
  'what',
  'does',
  'about',
  'which',
  'that',
  'this',
  'from',
  'with',
  'into',
  'than',
  'then',
  'over',
  'under',
  'more',
  'some',
  'will',
  'have',
  'been',
  'were',
  'being',
  'says',
  'say',
  'covers',
  'cover',
  'how',
  'when',
  'where',
  'who',
  'whom',
  'whose',
  'why',
  'also',
])

/**
 * Query-aware "people also ask": `tenant.suggestedQuestions` filtered to the
 * ones that actually share meaningful words with the current query, so the
 * widget reflects what was searched instead of showing the same static
 * chips for every query. Returns `[]` when nothing genuinely overlaps - the
 * caller hides the widget rather than showing irrelevant suggestions. (The
 * platform's per-resource synthetic-questions DA output isn't read back
 * anywhere yet - see the final report; this is a lightweight heuristic over
 * the tenant's own curated question list, not a rewrite of that task.)
 */
export function deriveRelatedQuestions(query: string, suggested: Question[]): Question[] {
  const lowered = query.trim().toLowerCase()
  const queryWords = new Set(
    lowered.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !RELATED_QUESTION_STOPWORDS.has(w)),
  )
  if (queryWords.size === 0) return []
  return suggested
    .filter((q) => q.text.toLowerCase() !== lowered)
    .map((q) => {
      const words = q.text.toLowerCase().split(/[^a-z0-9]+/).filter((w) =>
        w.length >= 4 && !RELATED_QUESTION_STOPWORDS.has(w)
      )
      const overlap = words.filter((w) => queryWords.has(w)).length
      return { q, overlap }
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 4)
    .map((s) => s.q)
}

export class KnowledgeBoxNotConnectedError extends Error {
  constructor(readonly slug: string) {
    super(`No knowledge box connected for tenant '${slug}'`)
    this.name = 'KnowledgeBoxNotConnectedError'
  }
}

export interface AragProviderOptions {
  /** Resolve the current binding for a tenant slug - called per request so bindings can change at runtime. */
  resolveBinding: (slug: string) => KbBinding | undefined
  fetchImpl?: typeof fetch
}

/**
 * RetrievalProvider backed by Progress Agentic RAG knowledge boxes - one KB
 * per tenant, bound by slug. Every answer, search result and resource comes
 * from the live regional API; nothing is fabricated here.
 */
export class AragProvider implements RetrievalProvider {
  private readonly clients = new Map<string, KbClient>()
  private readonly catalogCache = new Map<string, { at: number; resources: ResourceSummary[] }>()

  constructor(private readonly opts: AragProviderOptions) {}

  private client(tenant: TenantConfig): KbClient {
    const binding = this.opts.resolveBinding(tenant.slug)
    if (!binding) {
      this.invalidate(tenant.slug)
      throw new KnowledgeBoxNotConnectedError(tenant.slug)
    }
    const key = `${tenant.slug}:${binding.baseUrl}`
    const existing = this.clients.get(key)
    if (existing) return existing
    // A new binding for this slug invalidates anything cached for the old one.
    this.invalidate(tenant.slug)
    const client = new KbClient(binding, this.opts.fetchImpl ?? fetch)
    this.clients.set(key, client)
    return client
  }

  /** Drop cached clients and catalogue entries for a tenant (call after rebinding). */
  invalidate(slug: string): void {
    for (const key of this.clients.keys()) {
      if (key.startsWith(`${slug}:`)) this.clients.delete(key)
    }
    this.catalogCache.delete(slug)
  }

  private toSummary(id: string, raw: RawResource): ResourceSummary {
    const meta = raw.extra?.metadata ?? {}
    const topicFromLabels = classificationLabels(raw, 'topic')
    const kindLabel = classificationLabels(raw, 'kind')[0]
    const type: ResourceType = ((): ResourceType => {
      const t = meta.type
      return t === 'video' || t === 'web' || t === 'pdf' ? t : 'document'
    })()
    // Merchandise the raw title/summary so a filename ("1981-071-DLD.pdf") is
    // never the headline. Junk titles (hash/bot/system) collapse to "Untitled
    // resource" with no source name shown. The API overlays a generated
    // enrichment (real title/summary/takeaways/quotes) from its own store.
    const safe = displayTitle(raw.title, id)
    const rawTitle = safe === 'Untitled resource' ? '' : (raw.title ?? '')
    const merch = baselineMerchandising(rawTitle, meta.summary || raw.summary)
    return ResourceSummarySchema.parse({
      id,
      title: merch.title,
      summary: merch.summary,
      type,
      topicIds: topicFromLabels.length > 0 ? topicFromLabels : meta.topic ? [meta.topic] : [],
      keyFacts: meta.keyFacts ?? [],
      published: meta.published,
      ...(kindLabel ? { kind: kindLabel } : {}),
      ...(merch.sourceName ? { sourceName: merch.sourceName } : {}),
      enriched: false,
    })
  }

  async listResources(tenant: TenantConfig): Promise<ResourceSummary[]> {
    const cached = this.catalogCache.get(tenant.slug)
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.resources
    const client = this.client(tenant)
    // Read the catalogue in pages and build summaries from the page payload
    // itself. A per-resource fetch here would mean one request per document -
    // thousands of parallel calls on a real corpus, on the hot search path.
    const resources: ResourceSummary[] = []
    for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
      const catalog = await client.getJson<{ resources?: Record<string, RawResource> }>(
        `/catalog?page_number=${page}&page_size=${CATALOG_PAGE_SIZE}&show=basic&show=extra`,
      )
      const batch = Object.entries(catalog.resources ?? {})
      for (const [id, raw] of batch) {
        // Failed ingests and junk (hash/bot-challenge) titles never reach a
        // user-facing list - see isDisplayableResource.
        if (!isDisplayableResource(raw)) continue
        resources.push(this.toSummary(id, raw))
      }
      if (batch.length < CATALOG_PAGE_SIZE) break
    }
    resources.sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
    this.catalogCache.set(tenant.slug, { at: Date.now(), resources })
    return resources
  }

  async resource(tenant: TenantConfig, id: string): Promise<ResourceSummary | null> {
    try {
      const raw = await this.client(tenant).getJson<RawResource>(
        `/resource/${id}?show=basic&show=extra`,
      )
      return this.toSummary(id, raw)
    } catch (err) {
      if (err instanceof Error && 'status' in err && (err as { status: number }).status === 404) {
        return null
      }
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Management operations (admin surfaces) - all live platform calls.
  // -------------------------------------------------------------------------

  async counters(tenant: TenantConfig): Promise<KbCounters> {
    const raw = await this.client(tenant).getJson<{
      resources?: number
      paragraphs?: number
      sentences?: number
      index_size?: number
    }>('/counters')
    return {
      resources: raw.resources ?? 0,
      paragraphs: raw.paragraphs ?? 0,
      sentences: raw.sentences ?? 0,
      indexMb: Math.round((raw.index_size ?? 0) / 1e6),
    }
  }

  async recentResources(tenant: TenantConfig, limit = 12): Promise<RecentResource[]> {
    const raw = await this.client(tenant).getJson<{
      resources?: Record<string, RawResource & { created?: string }>
    }>(`/catalog?page_number=0&page_size=${limit}&show=basic&sort_field=created&sort_order=desc`)
    return Object.entries(raw.resources ?? {}).map(([id, r]) => {
      const status = r.metadata?.status
      return {
        id,
        title: r.title ?? id,
        status: status === 'PROCESSED' ? 'processed' : status === 'ERROR' ? 'error' : 'pending',
        created: r.created,
        hidden: (r as { hidden?: boolean }).hidden ?? false,
      }
    })
  }

  async uploadFile(
    tenant: TenantConfig,
    input: { filename: string; contentType: string; bytes: Uint8Array },
  ): Promise<{ id: string }> {
    const client = this.client(tenant)
    const res =
      (await withBackpressureRetry(() =>
        client.postRaw('/upload', input.bytes, input.contentType, input.filename)
      )) as { uuid?: string; resource?: string }
    this.invalidateCatalogue(tenant.slug)
    return { id: res.uuid ?? res.resource ?? '' }
  }

  async createLink(
    tenant: TenantConfig,
    input: { url: string; title?: string; hidden?: boolean },
  ): Promise<{ id: string }> {
    const client = this.client(tenant)
    const res = await withBackpressureRetry(() =>
      client.postJson<{ uuid?: string }>('/resources', {
        title: input.title ?? input.url,
        icon: 'application/stf-link',
        origin: { url: input.url },
        links: { link: { uri: input.url } },
        ...(input.hidden ? { hidden: true } : {}),
      })
    )
    this.invalidateCatalogue(tenant.slug)
    return { id: res.uuid ?? '' }
  }

  async createText(
    tenant: TenantConfig,
    input: {
      title: string
      body: string
      format?: 'PLAIN' | 'MARKDOWN'
      slug?: string
      topicId?: string
      extraMetadata?: Record<string, unknown>
      originUrl?: string
    },
  ): Promise<{ id: string }> {
    const body: Record<string, unknown> = {
      title: input.title,
      icon: 'text/plain',
      texts: { body: { body: input.body, format: input.format ?? 'MARKDOWN' } },
    }
    if (input.originUrl) body.origin = { url: input.originUrl }
    if (input.slug) body.slug = input.slug
    if (input.topicId) {
      body.usermetadata = { classifications: [{ labelset: 'topic', label: input.topicId }] }
    }
    if (input.extraMetadata) body.extra = { metadata: input.extraMetadata }
    const client = this.client(tenant)
    const res = await withBackpressureRetry(() =>
      client.postJson<{ uuid?: string }>('/resources', body)
    )
    this.invalidateCatalogue(tenant.slug)
    return { id: res.uuid ?? '' }
  }

  /** Full resource read for migration - extracted text per field, labels, origin. */
  async resourceFull(tenant: TenantConfig, id: string): Promise<{
    title: string
    slug?: string
    kind: 'text' | 'link' | 'file'
    originUrl?: string
    texts: { fieldId: string; body: string }[]
    topicIds: string[]
    extraMetadata?: Record<string, unknown>
  }> {
    const raw = await this.client(tenant).getJson<
      RawResource & {
        slug?: string
        origin?: { url?: string }
        data?: {
          texts?: Record<
            string,
            { value?: { body?: string }; extracted?: { text?: { text?: string } } }
          >
          links?: Record<string, { extracted?: { text?: { text?: string } } }>
          files?: Record<string, unknown>
        }
      }
    >(
      `/resource/${id}?show=basic&show=origin&show=values&show=extracted&show=extra&extracted=text&extracted=metadata`,
    )
    const texts: { fieldId: string; body: string }[] = []
    for (const [fieldId, field] of Object.entries(raw.data?.texts ?? {})) {
      const body = field.value?.body ?? field.extracted?.text?.text
      if (body) texts.push({ fieldId, body })
    }
    for (const [fieldId, field] of Object.entries(raw.data?.links ?? {})) {
      const body = field.extracted?.text?.text
      if (body) texts.push({ fieldId: `link:${fieldId}`, body })
    }
    const hasFiles = Object.keys(raw.data?.files ?? {}).length > 0
    const kind = raw.origin?.url && Object.keys(raw.data?.links ?? {}).length > 0
      ? 'link'
      : hasFiles
      ? 'file'
      : 'text'
    const summary = this.toSummary(id, raw)
    return {
      title: summary.title,
      slug: raw.slug,
      kind,
      originUrl: raw.origin?.url,
      texts,
      topicIds: summary.topicIds,
      extraMetadata: raw.extra?.metadata as Record<string, unknown> | undefined,
    }
  }

  /** Whether a resource slug already exists in the tenant's knowledge box. */
  async hasSlug(tenant: TenantConfig, slug: string): Promise<boolean> {
    try {
      await this.client(tenant).getJson(`/slug/${slug}`)
      return true
    } catch {
      return false
    }
  }

  private invalidateCatalogue(slug: string): void {
    this.catalogCache.delete(slug)
  }

  async suggest(tenant: TenantConfig): Promise<Question[]> {
    return tenant.suggestedQuestions
  }

  async search(
    tenant: TenantConfig,
    query: string,
    opts: SearchOptions = {},
  ): Promise<SearchResults> {
    const trimmed = query.trim()
    if (!trimmed) return { query, resources: [], relatedQuestions: [] }
    const client = this.client(tenant)
    const mode = opts.mode ?? 'hybrid'
    const features = mode === 'hybrid' ? ['keyword', 'semantic'] : [mode]
    const body: Record<string, unknown> = {
      query: trimmed,
      features,
      page_size: opts.pageSize ?? 20,
      show: ['basic', 'origin'],
      // Cross-encoder reranking pass over the retrieved candidates - verified
      // live (docs/ARAG-DEV.md has no prior record of this; see the reranker
      // note added there). This is in fact the platform's own default when
      // `reranker` is omitted (confirmed via `score_type: RERANKER` on an
      // unconfigured /find call), so pinning it here is defensive - it keeps
      // the box's next default change from silently un-reranking this path -
      // rather than a genuinely new capability. `findWithFallback` sheds it
      // on a 4xx same as `search_configuration`, so a deployment that
      // rejects the field still works.
      reranker: 'predict',
    }
    // The named search configuration's own features override the request's,
    // which would make the mode switch inert - only attach it for the
    // default hybrid mode.
    if (mode === 'hybrid') body.search_configuration = 'portal-search'
    const filters = [
      ...(opts.topicIds ?? []).map((t) => `/classification.labels/topic/${t}`),
      ...(opts.kindIds ?? []).map((k) => `/classification.labels/kind/${k}`),
    ]
    if (filters.length > 0) body.filters = filters
    const [found, all] = await Promise.all([
      this.findWithFallback(client, body),
      this.listResources(tenant),
    ])
    const byId = new Map(all.map((r) => [r.id, r]))
    // Failed ingests and junk (hash/bot-challenge) titles never surface as a
    // search result - see isDisplayableResource.
    const entries = Object.entries(found.resources ?? {}).filter(([, raw]) =>
      isDisplayableResource(raw)
    )
    // Relevance floor: below this a match is noise, and an off-corpus query
    // should say "no results" honestly rather than surface weak hits.
    const MIN_SCORE = 0.1
    const scored = entries
      .map(([id, raw]) => {
        let best = 0
        let passage: string | undefined
        let page: number | undefined
        for (const field of Object.values(raw.fields ?? {})) {
          for (const paragraph of Object.values(field.paragraphs ?? {})) {
            const score = paragraph.score ?? 0
            if (score >= best) {
              best = score
              passage = paragraph.text ?? passage
              page = (paragraph as { position?: { page_number?: number } }).position?.page_number
            }
          }
        }
        const reference = passage ? looksLikeReferenceChunk(passage) : false
        // A reference-list match is citation-title noise - keep it findable
        // but never let it outrank body text.
        return { id, raw, best: reference ? best * 0.4 : best, passage, page, reference }
      })
      .filter((s) => s.best >= MIN_SCORE)
    // Near-duplicate suppression: crawled pages repeat nav/footer chrome, so
    // two results opening with the same 120 characters are the same content.
    const seenSignatures = new Set<string>()
    const deduped = scored.sort((a, b) => b.best - a.best).filter((s) => {
      const signature = (s.passage ?? s.raw.title ?? s.id).slice(0, 120).toLowerCase()
      if (seenSignatures.has(signature)) return false
      seenSignatures.add(signature)
      return true
    })
    // Calibrated relevance, comparable across queries: semantic scores are
    // already 0-1; BM25 scores (>1) are squashed logistically. Never
    // normalised to the top hit - a weak best match must LOOK weak.
    const calibrate = (s: number): number => s <= 1 ? Math.max(0, Math.min(1, s)) : s / (s + 2)
    const resources: ScoredResource[] = deduped.map(
      ({ id, raw, best, passage, page, reference }) => ({
        ...(byId.get(id) ?? this.toSummary(id, raw)),
        relevance: Math.round(calibrate(best) * 100) / 100,
        citedCount: 0,
        matchedPassage: passage,
        ...(page ? { matchedPage: page } : {}),
        ...(reference ? { referenceChunk: true } : {}),
      }),
    )
    const relatedQuestions = deriveRelatedQuestions(trimmed, tenant.suggestedQuestions)
    return { query: trimmed, resources, relatedQuestions }
  }

  /**
   * POST /find with the fallback the platform's search configuration bug
   * needs: a stored config can exist but return zero for every query on an
   * admin-connected box while a config-free find works - shed it and retry
   * once, on a zero-result response or a 4xx before the fallback would ever
   * see output. Also sheds `reranker` on that same 4xx retry - verified
   * accepted on this deployment (see the reranker note in docs/ARAG-DEV.md),
   * but a box on an older platform build could still reject it, and this is
   * the same shed-and-retry-once pattern `ask` already uses for its own
   * optional strategies. Shared by `search` and the catalogue's
   * filtered-query path (`catalog`/`catalogByQuery`) so both use the exact
   * same retrieval call.
   */
  private async findWithFallback(
    client: KbClient,
    body: Record<string, unknown>,
  ): Promise<FindResponse> {
    try {
      const first = await client.postJson<FindResponse>('/find', body)
      if (body.search_configuration && Object.keys(first.resources ?? {}).length === 0) {
        delete body.search_configuration
        return await client.postJson<FindResponse>('/find', body)
      }
      return first
    } catch (err) {
      if (err instanceof AragApiError && err.status >= 400 && err.status < 500) {
        delete body.search_configuration
        delete body.reranker
        return await client.postJson<FindResponse>('/find', body)
      }
      throw err
    }
  }

  async catalog(tenant: TenantConfig, opts: CatalogOptions = {}): Promise<CatalogPage> {
    const query = opts.query?.trim()
    // A query filters the library, so it needs real retrieval, not the bare
    // `/catalog?query=` title-substring match (weak - it misses documents
    // `/find` finds for the same string). Route it through the same
    // retrieval path `search` uses; unfiltered browse/paging below is
    // untouched.
    if (query) return await this.catalogByQuery(tenant, query, opts)
    const params = new URLSearchParams()
    params.set('page_number', String(opts.page ?? 0))
    params.set('page_size', String(opts.pageSize ?? 24))
    params.append('show', 'basic')
    params.append('show', 'extra')
    params.set('sort_field', opts.sortField ?? 'created')
    params.set('sort_order', opts.sortOrder ?? 'desc')
    params.set('hidden', 'false')
    for (const topic of opts.topicIds ?? []) {
      params.append('filters', `/classification.labels/topic/${topic}`)
    }
    for (const kind of opts.kindIds ?? []) {
      params.append('filters', `/classification.labels/kind/${kind}`)
    }
    const raw = await this.client(tenant).getJson<{
      resources?: Record<string, RawResource & { created?: string }>
      fulltext?: { total?: number }
      total?: number
    }>(`/catalog?${params.toString()}`)
    // Failed ingests and junk (hash/bot-challenge) titles never surface in
    // the library - see isDisplayableResource.
    const entries = Object.entries(raw.resources ?? {}).filter(([, r]) => isDisplayableResource(r))
    const items: CatalogItem[] = entries.map(([id, r]) => catalogItemFromRaw(id, r))
    return { items, total: raw.fulltext?.total ?? raw.total ?? items.length }
  }

  /**
   * Top resources filed under one topic - drives Explore's topic rows. Reads
   * the box's classification INDEX via `/catalog`'s param-based `filters=`
   * (the same call `catalog()`'s unfiltered/topic-filtered browse above
   * makes), not `/find`'s JSON-body `filters` array - docs/ARAG-DEV.md
   * records that legacy array silently returning zero for label paths, and
   * this `/catalog` param form is verified live to return real, non-empty
   * results filtered by `/classification.labels/topic/{id}` even though a
   * resource's own `usermetadata.classifications` can be empty for the same
   * resource (the classifier's labels live in the index, not necessarily in
   * that field - see the final report). Deliberately independent of
   * `listResources`'s per-resource `topicIds`, which the DA classifier's
   * labels don't reliably populate.
   */
  async topicResources(
    tenant: TenantConfig,
    topicId: string,
    limit = 12,
  ): Promise<ResourceSummary[]> {
    const params = new URLSearchParams()
    params.set('page_number', '0')
    params.set('page_size', String(limit))
    params.append('show', 'basic')
    params.append('show', 'extra')
    params.set('sort_field', 'created')
    params.set('sort_order', 'desc')
    params.set('hidden', 'false')
    params.append('filters', `/classification.labels/topic/${topicId}`)
    const raw = await this.client(tenant).getJson<{ resources?: Record<string, RawResource> }>(
      `/catalog?${params.toString()}`,
    )
    // Failed ingests and junk (hash/bot-challenge) titles never surface in a
    // topic row - see isDisplayableResource.
    return Object.entries(raw.resources ?? {})
      .filter(([, r]) => isDisplayableResource(r))
      .map(([id, r]) => this.toSummary(id, r))
  }

  /**
   * Filtered catalogue browse: real retrieval via `/find` (the same path
   * `search` uses), reshaped into the catalogue's own item shape and paged
   * in-memory over the candidate pool. `total` reflects the candidate pool
   * actually scored (capped below), not the platform's full-corpus count.
   */
  private async catalogByQuery(
    tenant: TenantConfig,
    query: string,
    opts: CatalogOptions,
  ): Promise<CatalogPage> {
    const client = this.client(tenant)
    const body: Record<string, unknown> = {
      query,
      features: ['keyword', 'semantic'],
      page_size: 200,
      show: ['basic', 'extra'],
      search_configuration: 'portal-search',
    }
    const filters = [
      ...(opts.topicIds ?? []).map((t) => `/classification.labels/topic/${t}`),
      ...(opts.kindIds ?? []).map((k) => `/classification.labels/kind/${k}`),
    ]
    if (filters.length > 0) body.filters = filters
    const found = await this.findWithFallback(client, body)
    const MIN_SCORE = 0.1
    const scored = Object.entries(found.resources ?? {})
      .filter(([, raw]) => isDisplayableResource(raw))
      .map(([id, raw]) => {
        let best = 0
        for (const field of Object.values(raw.fields ?? {})) {
          for (const paragraph of Object.values(field.paragraphs ?? {})) {
            best = Math.max(best, paragraph.score ?? 0)
          }
        }
        return { id, raw, best }
      })
      .filter((s) => s.best >= MIN_SCORE)
      .sort((a, b) => b.best - a.best)
    const items = scored.map(({ id, raw }) => catalogItemFromRaw(id, raw))
    const page = opts.page ?? 0
    const pageSize = opts.pageSize ?? 24
    const start = page * pageSize
    return { items: items.slice(start, start + pageSize), total: items.length }
  }

  async facets(
    tenant: TenantConfig,
    labelsets: string[],
    filters?: string[],
  ): Promise<FacetCounts> {
    if (labelsets.length === 0) return {}
    const params = new URLSearchParams({ page_size: '0' })
    for (const id of labelsets) params.append('faceted', `/classification.labels/${id}`)
    for (const f of filters ?? []) params.append('filters', f)
    const raw = await this.client(tenant).getJson<{
      fulltext?: { facets?: Record<string, Record<string, number>> }
      facets?: Record<string, Record<string, number>>
    }>(`/catalog?${params.toString()}`)
    const source = raw.fulltext?.facets ?? raw.facets ?? {}
    // The index can surface platform-computed classifications under the same
    // paths - keep only labels the labelset actually defines.
    const defined = new Map(
      (await this.labelsets(tenant)).map((ls) => [ls.id, new Set(ls.labels)]),
    )
    const out: FacetCounts = {}
    for (const [facetKey, counts] of Object.entries(source)) {
      const labelsetId = facetKey.split('/').pop() ?? facetKey
      const allowed = defined.get(labelsetId)
      const byLabel: Record<string, number> = {}
      for (const [labelPath, count] of Object.entries(counts)) {
        const label = labelPath.split('/').pop() ?? labelPath
        if (allowed && !allowed.has(label)) continue
        byLabel[label] = count
      }
      out[labelsetId] = byLabel
    }
    return out
  }

  async labelsets(tenant: TenantConfig): Promise<Labelset[]> {
    const raw = await this.client(tenant).getJson<{
      labelsets?: Record<
        string,
        { title?: string; multiple?: boolean; kind?: string[]; labels?: { title?: string }[] }
      >
    }>('/labelsets')
    return Object.entries(raw.labelsets ?? {}).map(([id, ls]) => ({
      id,
      title: ls.title ?? id,
      multiple: ls.multiple ?? true,
      kind: (ls.kind ?? []).includes('PARAGRAPHS') ? 'PARAGRAPHS' as const : 'RESOURCES' as const,
      labels: (ls.labels ?? []).map((l) => l.title ?? '').filter(Boolean),
    }))
  }

  /**
   * Label co-occurrence graph, the reference portal's model: primary labels
   * become weighted nodes; for each, the secondary facet counts WITHIN that
   * primary filter become edges. N+1 catalog calls, so primaries are capped.
   */
  async graphData(tenant: TenantConfig, primary: string, secondary: string): Promise<GraphData> {
    const [primaryCountsAll, labelsets] = await Promise.all([
      this.facets(tenant, [primary]),
      this.labelsets(tenant).catch(() => []),
    ])
    // Facet keys are label slugs. Some labelsets store real display titles
    // ("Investment Strategy"), others store the slug itself - only a mapping
    // that genuinely differs is a display title.
    const displayTitle = new Map<string, string>()
    for (const ls of labelsets) {
      for (const label of ls.labels) {
        const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        if (label !== slug) displayTitle.set(slug, label)
      }
    }
    // The organisation's acronym ("GRDC" from "Grains Research and
    // Development Corporation") should stay uppercase in fallback titles.
    const acronym = tenant.branding.organisation
      .split(/\s+/)
      .filter((w) => /^[A-Z]/.test(w))
      .map((w) => w[0])
      .join('')
      .toLowerCase()
    const pretty = (slug: string) =>
      displayTitle.get(slug) ??
        slug.split('-').map((w) =>
          w === acronym ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)
        ).join(' ')
    const primaryCounts = primaryCountsAll[primary] ?? {}
    const primaries = Object.entries(primaryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 14)
    const nodes: GraphData['nodes'] = primaries.map(([label, weight]) => ({
      id: `${primary}:${label}`,
      label: pretty(label),
      group: 'primary',
      weight,
    }))
    const edges: GraphData['edges'] = []
    const secondaryTotals = new Map<string, number>()
    for (const [label] of primaries) {
      const within = await this.facets(
        tenant,
        [secondary],
        [`/classification.labels/${primary}/${label}`],
      )
      for (const [secLabel, count] of Object.entries(within[secondary] ?? {})) {
        if (count <= 0) continue
        edges.push({
          source: `${primary}:${label}`,
          target: `${secondary}:${secLabel}`,
          weight: count,
        })
        secondaryTotals.set(secLabel, (secondaryTotals.get(secLabel) ?? 0) + count)
      }
    }
    for (const [label, weight] of secondaryTotals) {
      nodes.push({ id: `${secondary}:${label}`, label: pretty(label), group: 'secondary', weight })
    }
    return { primary, secondary, nodes, edges }
  }

  /**
   * Query-time structured generation. Citations must stay OFF here - the
   * platform 500s when citations and answer_json_schema are combined; sources
   * come from the retrieval event instead.
   *
   * `requireGrounding` gates fabrication on a thin or broken corpus.
   * Structured generation has no textual guardrail to detect the way `ask`
   * detects the platform's "not enough data to answer this." sentence - the
   * model only ever returns valid JSON, whether fabricated from background
   * knowledge or not. When set, retrieval hits are scored and calibrated the
   * same way `ask` scores its grounding sources (`bestParagraphMatch` +
   * `calibrateRelevance`, floored at `MIN_GENERATE_GROUNDING` - the same
   * floor `search` applies), and if nothing survives, the model's JSON is
   * discarded and `insufficientGrounding: true` is returned instead - the
   * structured-artefact equivalent of `ask`'s honest refusal. When grounding
   * is weak but present, `sources` is filtered to the surviving (real,
   * relevant) sources only, so a caller emitting per-item citations never
   * has anything below the floor to cite.
   *
   * Off by default: callers that don't produce user-facing factual
   * artefacts (sub-question decomposition, source verdicts, investigation
   * synthesis - which already grounds strictly on the researcher's own kept
   * evidence, corpus analysis) keep their existing behaviour unchanged.
   */
  async askStructured(
    tenant: TenantConfig,
    schema: { name: string; description: string; parameters: unknown },
    query: string,
    opts: { requireGrounding?: boolean; resourceId?: string } = {},
  ): Promise<{ object: unknown; sources: ScoredResource[]; insufficientGrounding: boolean }> {
    const client = this.client(tenant)
    const catalogue = await this.listResources(tenant).catch(() => [] as ResourceSummary[])
    const byId = new Map(catalogue.map((r) => [r.id, r]))
    const res = await client.postStream('/ask', {
      query,
      features: ['keyword', 'semantic'],
      answer_json_schema: schema,
      show: ['basic', 'origin'],
      // Scope generation to one resource (per-resource enrichment) - the same
      // resource_filters the per-document chat uses. Verified live: it grounds
      // the answer on exactly that resource.
      ...(opts.resourceId ? { resource_filters: [opts.resourceId] } : {}),
      // The default cap triggers 412 "Error generating json: max_tokens" on
      // large payloads like comparison matrices.
      max_tokens: 4096,
    })
    let object: unknown = null
    let sources: ScoredResource[] = []
    for await (const line of ndjson(res)) {
      const item = (line as { item?: { type?: string } & Record<string, unknown> }).item
      if (!item?.type) continue
      if (item.type === 'retrieval') {
        const results = item.results as {
          resources?: Record<
            string,
            RawResource & {
              fields?: Record<
                string,
                {
                  paragraphs?: Record<
                    string,
                    { score?: number; text?: string; position?: { page_number?: number } }
                  >
                }
              >
            }
          >
        } | undefined
        sources = Object.entries(results?.resources ?? {})
          .map(([id, raw]) => {
            const match = bestParagraphMatch(raw)
            return {
              ...(byId.get(id) ?? this.toSummary(id, raw)),
              relevance: Math.round(calibrateRelevance(match.best) * 100) / 100,
              citedCount: 0,
              matchedPassage: match.passage,
              ...(match.page ? { matchedPage: match.page } : {}),
              ...(match.reference ? { referenceChunk: true } : {}),
            }
          })
          .slice(0, 12)
      } else if (item.type === 'answer_json' && item.object !== undefined) {
        object = item.object
      }
    }
    const grounded = sources.filter((s) => s.relevance >= MIN_GENERATE_GROUNDING)
    if (opts.requireGrounding && grounded.length === 0) {
      return { object: null, sources: grounded, insufficientGrounding: true }
    }
    if (object === null) {
      throw new Error('The platform returned no structured answer - try a narrower request')
    }
    return {
      object,
      sources: opts.requireGrounding ? grounded : sources,
      insufficientGrounding: false,
    }
  }

  /** Replace a resource's classifications (used by corpus analysis). */
  async patchResourceClassifications(
    tenant: TenantConfig,
    resourceId: string,
    classifications: { labelset: string; label: string }[],
  ): Promise<void> {
    await this.client(tenant).patchJson(`/resource/${resourceId}`, {
      usermetadata: { classifications },
    })
    this.invalidateCatalogue(tenant.slug)
  }

  async createLabelset(
    tenant: TenantConfig,
    input: {
      id: string
      title: string
      multiple: boolean
      labels: string[]
      kind?: 'RESOURCES' | 'PARAGRAPHS'
    },
  ): Promise<void> {
    await this.client(tenant).postJson(`/labelset/${input.id}`, {
      title: input.title,
      color: '#556b5f',
      multiple: input.multiple,
      kind: [input.kind ?? 'RESOURCES'],
      labels: input.labels.map((title) => ({ title })),
    })
  }

  // -------------------------------------------------------------------------
  // Data-augmentation agents (DA tasks on the data-plane host).
  // -------------------------------------------------------------------------

  /** The box's configured generative model - DA tasks must pin it. */
  async generativeModel(tenant: TenantConfig): Promise<string> {
    try {
      const cfg = await this.client(tenant).getJson<{ generative_model?: string }>(
        '/configuration',
      )
      return cfg.generative_model ?? ''
    } catch {
      return ''
    }
  }

  async listAgents(tenant: TenantConfig): Promise<KbAgent[]> {
    const raw = await this.client(tenant).dpJson<Record<string, unknown>>('GET', '/tasks')
    const agents: KbAgent[] = []
    const collect = (entries: unknown) => {
      if (!Array.isArray(entries)) return
      for (const entry of entries) {
        const e = entry as {
          id?: string
          task?: { name?: string }
          parameters?: { name?: string }
        }
        const id = e.id
        if (!id || agents.some((a) => a.id === id)) continue
        agents.push({
          id,
          task: e.task?.name ?? 'unknown',
          title: e.parameters?.name ?? e.task?.name ?? id,
        })
      }
    }
    for (const value of Object.values(raw ?? {})) collect(value)
    return agents
  }

  /**
   * The live knowledge-graph strategy: entity types (NER definitions) and the
   * worked examples that teach relation extraction, read from the registered
   * llm-graph agent's own configuration.
   */
  async graphStrategy(tenant: TenantConfig): Promise<
    {
      taskId: string
      title: string
      ident: string
      entityDefs: { label: string; description?: string }[]
      examples: {
        text: string
        entities: { name: string; label: string }[]
        relations: { source: string; target: string; label: string }[]
      }[]
    } | null
  > {
    const raw = await this.client(tenant).dpJson<{
      configs?: {
        id?: string
        task?: string | { name?: string }
        parameters?: {
          name?: string
          operations?: {
            graph?: {
              ident?: string
              entity_defs?: { label?: string; description?: string }[]
              examples?: {
                text?: string
                entities?: { name?: string; label?: string }[]
                relations?: { source?: string; target?: string; label?: string }[]
              }[]
            }
          }[]
        }
      }[]
    }>('GET', '/tasks')
    for (const config of raw.configs ?? []) {
      const taskName = typeof config.task === 'string' ? config.task : config.task?.name
      if (taskName !== 'llm-graph') continue
      const graph = (config.parameters?.operations ?? []).find((op) => op.graph)?.graph
      if (!graph) continue
      return {
        taskId: config.id ?? '',
        title: config.parameters?.name ?? '',
        ident: graph.ident ?? 'kg1',
        entityDefs: (graph.entity_defs ?? []).map((d) => ({
          label: d.label ?? '',
          description: d.description,
        })).filter((d) => d.label),
        examples: (graph.examples ?? []).map((e) => ({
          text: e.text ?? '',
          entities: (e.entities ?? []).map((en) => ({
            name: en.name ?? '',
            label: en.label ?? '',
          })),
          relations: (e.relations ?? []).map((r) => ({
            source: r.source ?? '',
            target: r.target ?? '',
            label: r.label ?? '',
          })),
        })),
      }
    }
    return null
  }

  async startAgent(
    tenant: TenantConfig,
    input: {
      task: string
      title: string
      operations: unknown[]
      applyExisting: boolean
      model: string
    },
  ): Promise<void> {
    const parameters: Record<string, unknown> = {
      name: input.title,
      on: 1,
      operations: input.operations,
    }
    if (input.model) parameters.llm = { model: input.model }
    await this.client(tenant).dpJson('POST', '/task/start', {
      name: input.task,
      parameters,
      apply: input.applyExisting ? 'ALL' : 'NEW',
      enabled: true,
    })
  }

  /** REMi answer-quality scores (0-5) for a generated answer. */
  async remi(
    tenant: TenantConfig,
    input: { question: string; answer: string; contexts: string[] },
  ): Promise<
    { answerRelevance: number | null; groundedness: number | null; contextRelevance: number | null }
  > {
    const raw = await this.client(tenant).postJson<{
      answer_relevance?: { score?: number } | null
      context_relevance?: (number | null)[] | null
      groundedness?: (number | null)[] | null
    }>('/predict/remi', {
      user_id: 'research-portal',
      question: input.question,
      answer: input.answer,
      contexts: input.contexts.slice(0, 20).map((c) => c.slice(0, 2000)),
    })
    const clean = (values?: (number | null)[] | null): number[] =>
      (values ?? []).filter((v): v is number => typeof v === 'number')
    // Context expansion pads retrieval with neighbouring/graph paragraphs, so
    // averages over ALL contexts under-report. Groundedness asks "is the
    // answer supported by the retrieved material" - the best supporting
    // context answers that (max). Context relevance reports the top five.
    const grounded = clean(raw.groundedness)
    const relevant = clean(raw.context_relevance).sort((a, b) => b - a).slice(0, 5)
    return {
      answerRelevance: raw.answer_relevance?.score ?? null,
      groundedness: grounded.length ? Math.max(...grounded) : null,
      contextRelevance: relevant.length
        ? Math.round((relevant.reduce((a, b) => a + b, 0) / relevant.length) * 10) / 10
        : null,
    }
  }

  /** The REAL extracted knowledge graph: entity-relation-entity paths. */
  async relationsGraph(
    tenant: TenantConfig,
    opts: { entity?: string; topK?: number } = {},
  ): Promise<{
    nodes: { id: string; group: string; weight: number }[]
    edges: { source: string; target: string; label: string }[]
  }> {
    try {
      // Only agent-extracted relations - the built-in NER pipeline floods the
      // path index (PERSON/DATE/LOC) and would drown the curated graph. With
      // an entity, scope to that node's neighbourhood in either direction.
      const generated = { prop: 'generated', by: 'data-augmentation' }
      const query = opts.entity
        ? {
          and: [
            {
              prop: 'path',
              source: { value: opts.entity, match: 'exact' },
              undirected: true,
            },
            generated,
          ],
        }
        : generated
      const raw = await this.client(tenant).postJson<{
        paths?: {
          source?: { value?: string; group?: string }
          relation?: { label?: string }
          destination?: { value?: string; group?: string }
        }[]
      }>('/graph', { query, top_k: opts.topK ?? 400 })
      const weight = new Map<string, { group: string; weight: number }>()
      const edges: { source: string; target: string; label: string }[] = []
      const seenEdge = new Set<string>()
      // The graph agent names groups inconsistently ("Program"/"Programs") -
      // canonicalise on a singular key, keeping the first spelling seen.
      const groupSpellings = new Map<string, string>()
      const canonicalGroup = (raw: string): string => {
        if (!raw) return raw
        const key = raw.toLowerCase().replace(/s$/, '')
        const existing = groupSpellings.get(key)
        if (existing) return existing
        groupSpellings.set(key, raw)
        return raw
      }
      for (const path of raw.paths ?? []) {
        const s = path.source?.value
        const d = path.destination?.value
        if (!s || !d || s === d) continue
        const sg = path.source?.group ?? ''
        const dg = path.destination?.group ?? ''
        // Entity-entity relations only: skip built-in NER groups, label
        // assignment paths (topic/... targets) and raw resource-id nodes.
        if (/^[A-Z0-9_]+$/.test(sg) || /^[A-Z0-9_]+$/.test(dg)) continue
        if (s.includes('/') || d.includes('/')) continue
        if (/^[0-9a-f]{32}$/.test(s) || /^[0-9a-f]{32}$/.test(d)) continue
        const label = path.relation?.label ?? 'related to'
        const key = `${s}|${label}|${d}`
        if (seenEdge.has(key)) continue
        seenEdge.add(key)
        edges.push({ source: s, target: d, label })
        for (const [value, group] of [[s, sg], [d, dg]] as const) {
          const canonical = canonicalGroup(group)
          const entry = weight.get(value) ?? { group: canonical, weight: 0 }
          entry.weight += 1
          if (canonical) entry.group = canonical
          weight.set(value, entry)
        }
      }
      const nodes = [...weight.entries()]
        .map(([id, v]) => ({ id, group: v.group, weight: v.weight }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 120)
      const keep = new Set(nodes.map((n) => n.id))
      return { nodes, edges: edges.filter((e) => keep.has(e.source) && keep.has(e.target)) }
    } catch {
      return { nodes: [], edges: [] }
    }
  }

  /** Grounded multi-resource summary via the box's summarize endpoint. */
  async summarize(
    tenant: TenantConfig,
    resourceIds: string[],
    kind: 'simple' | 'extended' = 'simple',
  ): Promise<string> {
    const raw = await this.client(tenant).postJson<{
      summary?: string
      resources?: Record<string, { summary?: string }>
    }>('/summarize', { resources: resourceIds.slice(0, 20), summary_kind: kind })
    if (raw.summary?.trim()) return raw.summary
    return Object.values(raw.resources ?? {})
      .map((r) => r.summary ?? '')
      .filter(Boolean)
      .join('\n\n')
  }

  /** The platform's rephrasing of a query; null when unchanged/unavailable. */
  async rephrase(tenant: TenantConfig, question: string): Promise<string | null> {
    try {
      const raw = await this.client(tenant).postJson<unknown>('/predict/rephrase', {
        question,
        user_id: 'research-portal',
      })
      const text = typeof raw === 'string'
        ? raw
        : (raw as { rephrased_query?: string; text?: string }).rephrased_query ??
          (raw as { text?: string }).text ?? ''
      // The predict endpoint appends a single status digit to the rephrased text.
      const cleaned = text.trim().replace(/[01]$/, '').trim().replace(/\?+$/, (m) => m.slice(0, 1))
      if (!cleaned || cleaned.toLowerCase() === question.trim().toLowerCase()) return null
      return cleaned
    } catch {
      return null
    }
  }

  /** Give the platform feedback on an answer (its learning loop). */
  async feedback(
    tenant: TenantConfig,
    input: { learningId: string; good: boolean; text?: string },
  ): Promise<void> {
    await this.client(tenant).postJson('/feedback', {
      ident: input.learningId,
      good: input.good,
      task: 'CHAT',
      ...(input.text ? { feedback: input.text } : {}),
    })
  }

  /** Remove a resource permanently (curation - e.g. replacing a corrupt ingest). */
  async deleteResource(tenant: TenantConfig, id: string): Promise<void> {
    await this.client(tenant).deleteJson(`/resource/${id}`)
    this.invalidateCatalogue(tenant.slug)
  }

  /** Show or hide a resource from searchers (draft/publish workflow). */
  async setResourceHidden(tenant: TenantConfig, id: string, hidden: boolean): Promise<void> {
    await this.client(tenant).patchJson(`/resource/${id}`, { hidden })
    this.invalidateCatalogue(tenant.slug)
  }

  /**
   * Purge failed-crawl junk (bot-challenge pages, and error-status resources
   * that never got a title) - see `isPurgeEligible` for the exact,
   * deliberately conservative rule. Pages the ENTIRE catalogue (not the
   * health-scan's newest-slice sample), same page/max-page pattern as
   * `listResources`, so a box with thousands of resources is fully scanned.
   *
   * `dryRun` (the caller's default) never calls `deleteResource` - it only
   * reports what WOULD be deleted, so a caller can confirm scope before
   * committing. A real run deletes in bounded waves of
   * `PURGE_DELETE_CONCURRENCY` so the box is never hit with an unbounded
   * burst of parallel deletes; one resource's delete failing is logged and
   * counted but never aborts the rest of the run.
   */
  async purgeFailedResources(
    tenant: TenantConfig,
    opts: { dryRun: boolean },
  ): Promise<
    { scanned: number; eligible: number; deleted: number; failed: number; sampleTitles: string[] }
  > {
    const client = this.client(tenant)
    const candidates: { id: string; title: string }[] = []
    let scanned = 0
    for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
      const catalog = await client.getJson<{ resources?: Record<string, RawResource> }>(
        `/catalog?page_number=${page}&page_size=${CATALOG_PAGE_SIZE}&show=basic`,
      )
      const batch = Object.entries(catalog.resources ?? {})
      scanned += batch.length
      for (const [id, raw] of batch) {
        if (isPurgeEligible(raw)) {
          candidates.push({ id, title: (raw.title ?? '').trim() || '(untitled)' })
        }
      }
      if (batch.length < CATALOG_PAGE_SIZE) break
    }
    const sampleTitles = candidates.slice(0, PURGE_SAMPLE_SIZE).map((r) => `${r.title} (${r.id})`)

    if (opts.dryRun) {
      return { scanned, eligible: candidates.length, deleted: 0, failed: 0, sampleTitles }
    }

    let deleted = 0
    let failed = 0
    for (let start = 0; start < candidates.length; start += PURGE_DELETE_CONCURRENCY) {
      const wave = candidates.slice(start, start + PURGE_DELETE_CONCURRENCY)
      const results = await Promise.allSettled(
        wave.map((r) =>
          this.deleteResource(tenant, r.id).catch((err) => {
            throw new Error(
              `failed to delete "${r.title}" (${r.id}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          })
        ),
      )
      for (const result of results) {
        if (result.status === 'fulfilled') {
          deleted++
        } else {
          failed++
          console.error(`purgeFailedResources(${tenant.slug}):`, result.reason)
        }
      }
    }
    return { scanned, eligible: candidates.length, deleted, failed, sampleTitles }
  }

  /**
   * Corpus health: word count and extraction sanity for every resource, so
   * bot-challenge pages and empty extractions surface in Manage instead of
   * being cited as sources.
   */
  async corpusHealth(tenant: TenantConfig): Promise<{
    id: string
    title: string
    words: number
    status: 'ok' | 'thin' | 'challenge'
    hidden: boolean
  }[]> {
    const client = this.client(tenant)
    const all: Record<string, RawResource & { hidden?: boolean }> = {}
    for (let page = 0; page < 10; page++) {
      const catalog = await client.getJson<{
        resources?: Record<string, RawResource & { hidden?: boolean }>
      }>(`/catalog?page_number=${page}&page_size=100&show=basic`)
      const batch = catalog.resources ?? {}
      Object.assign(all, batch)
      if (Object.keys(batch).length < 100) break
    }
    const CHALLENGE =
      /(cloudflare|enable javascript and cookies|just a moment|performing security verification|ray id|checking your browser)/i
    // Reading every resource's extracted text is one request per document -
    // scan the newest slice and run it in bounded waves so a big corpus is
    // never hammered with thousands of parallel calls.
    const entries = Object.entries(all).slice(0, HEALTH_SCAN_LIMIT)
    const results: {
      id: string
      title: string
      words: number
      status: 'ok' | 'thin' | 'challenge'
      hidden: boolean
    }[] = []
    for (let start = 0; start < entries.length; start += HEALTH_SCAN_CONCURRENCY) {
      const wave = entries.slice(start, start + HEALTH_SCAN_CONCURRENCY)
      results.push(
        ...await Promise.all(wave.map(async ([id, meta]) => {
          try {
            const full = await client.getJson<{
              title?: string
              data?: Record<
                string,
                Record<string, { extracted?: { text?: { text?: string } } }>
              >
            }>(`/resource/${id}?show=extracted&extracted=text&show=basic`)
            const texts: string[] = []
            for (const fieldType of Object.values(full.data ?? {})) {
              for (const field of Object.values(fieldType ?? {})) {
                const text = field.extracted?.text?.text
                if (text) texts.push(text)
              }
            }
            const body = texts.join(' ')
            const words = body.trim() ? body.trim().split(/\s+/).length : 0
            const status = CHALLENGE.test(body.slice(0, 2500))
              ? 'challenge' as const
              : words < 120
              ? 'thin' as const
              : 'ok' as const
            return {
              id,
              title: full.title ?? meta.title ?? id,
              words,
              status,
              hidden: meta.hidden ?? false,
            }
          } catch {
            return {
              id,
              title: meta.title ?? id,
              words: 0,
              status: 'thin' as const,
              hidden: meta.hidden ?? false,
            }
          }
        })),
      )
    }
    return results.sort((a, b) =>
      (a.status === 'ok' ? 1 : 0) - (b.status === 'ok' ? 1 : 0) || b.words - a.words
    )
  }

  /**
   * Type-ahead: entity and title suggestions. The platform's `/suggest`
   * index alone is weak on short prefixes - it can rank author-name/
   * fragment noise over an obviously-relevant title (a query like "abal"
   * never surfacing "abalone"), so every candidate (platform or local) is
   * required to actually contain the query as a prefix or a whole word, and
   * results are backed by a lightweight prefix match over the corpus's own
   * (already-filtered, per isDisplayableResource) titles and the tenant's
   * topic labels when the platform index comes up short.
   */
  async typeahead(
    tenant: TenantConfig,
    query: string,
  ): Promise<{ entities: string[]; titles: string[] }> {
    const trimmed = query.trim()
    if (!trimmed) return { entities: [], titles: [] }
    const q = trimmed.toLowerCase()
    const matchesQuery = (value: string): boolean => {
      const v = value.toLowerCase()
      if (v.startsWith(q)) return true
      return v.split(/[^a-z0-9]+/).some((word) => word.length > 0 && word.startsWith(q))
    }

    const [resources, platform] = await Promise.all([
      this.listResources(tenant).catch(() => [] as ResourceSummary[]),
      this.client(tenant)
        .getJson<{
          entities?: { entities?: { value?: string }[] }
          paragraphs?: { results?: { rid?: string; field?: string; text?: string }[] }
        }>(`/suggest?query=${encodeURIComponent(trimmed)}&features=entities&features=paragraph`)
        .catch(() => ({ entities: undefined, paragraphs: undefined })),
    ])
    const displayableIds = new Set(resources.map((r) => r.id))

    // The graph agent occasionally extracts vague time/direction words as
    // entities - keep suggestions to substantive names that actually match
    // the query, dropping single-fragment noise unrelated to it.
    const NOISE =
      /^(recent|early|late|last|next|this|coming|current|previous)\b|^(north|south|east|west)$|^(january|february|march|april|may|june|july|august|september|october|november|december)\b|^\d{1,4}$/i
    const entities = (platform.entities?.entities ?? [])
      .map((e) => (e.value ?? '').trim())
      .filter((v) => v.length > 2 && !NOISE.test(v) && !v.includes('\n') && matchesQuery(v))
      .slice(0, 6)

    const seen = new Set<string>()
    const titles: string[] = []
    for (const r of platform.paragraphs?.results ?? []) {
      if (r.field !== 'title' || !r.text || !r.rid || seen.has(r.rid)) continue
      // Drop hits on hidden/junk resources (error status, hash or
      // bot-challenge titles) and anything that doesn't actually match.
      if (!displayableIds.has(r.rid) || !matchesQuery(r.text)) continue
      seen.add(r.rid)
      titles.push(r.text)
      if (titles.length >= 5) break
    }

    // Local fallback/augmentation over real, displayable resource titles.
    if (titles.length < 5) {
      for (const r of resources) {
        if (seen.has(r.id) || titles.includes(r.title) || !matchesQuery(r.title)) continue
        seen.add(r.id)
        titles.push(r.title)
        if (titles.length >= 5) break
      }
    }
    // Known topic/entity terms - a query like "abal" should surface an
    // "Abalone" topic chip even when no title happens to start with it.
    if (entities.length < 6) {
      for (const topic of tenant.topics) {
        if (entities.includes(topic.label) || !matchesQuery(topic.label)) continue
        entities.push(topic.label)
        if (entities.length >= 6) break
      }
    }

    return { entities, titles }
  }

  /** Named search configurations on the box - the wiring for every surface. */
  async listSearchConfigs(tenant: TenantConfig): Promise<Record<string, unknown>> {
    try {
      return await this.client(tenant).getJson<Record<string, unknown>>('/search_configurations')
    } catch {
      return {}
    }
  }

  /**
   * Ensure the portal's named search configurations exist on the box - one per
   * surface, so retrieval behaviour is configured centrally rather than ad hoc.
   *
   * `reranker: 'predict'` on portal-search/portal-ask pins the platform's
   * cross-encoder reranking pass on the stored config too, not just the
   * request body `search`/`ask` already send it in - verified accepted here
   * (`docs/ARAG-DEV.md`'s reranker note; a bad value 422s with
   * `str-enum[RerankerName]` naming exactly `'predict'`/`'noop'`, and a
   * config created with it round-trips 201). Left off portal-typeahead,
   * which is keyword-only prefix matching for short partial queries - not
   * the kind of relevance ranking a semantic reranker is built for, and it
   * is on the typeahead hot path where the platform's own default already
   * applies with no extra round-trip cost from a stored field. Each entry's
   * own try/catch below already no-ops if a deployment rejects the shape.
   */
  async ensureSearchConfigs(tenant: TenantConfig): Promise<string[]> {
    const client = this.client(tenant)
    const desired: Record<string, unknown> = {
      'portal-search': {
        kind: 'find',
        config: { features: ['keyword', 'semantic'], top_k: 20, reranker: 'predict' },
      },
      'portal-ask': {
        kind: 'ask',
        config: { features: ['keyword', 'semantic'], citations: true, reranker: 'predict' },
      },
      'portal-typeahead': {
        kind: 'find',
        config: { features: ['keyword'], top_k: 8 },
      },
    }
    const created: string[] = []
    for (const [name, body] of Object.entries(desired)) {
      try {
        await client.postJson(`/search_configurations/${name}`, body)
        created.push(name)
      } catch {
        // Exists already or the deployment rejects the shape - not fatal.
      }
    }
    return created
  }

  /** Entity groups the graph agent has extracted (native knowledge graph). */
  async entityGroups(
    tenant: TenantConfig,
  ): Promise<{ group: string; entities: string[] }[]> {
    try {
      const client = this.client(tenant)
      const raw = await client.getJson<{
        groups?: Record<string, { entities?: Record<string, unknown> }>
      }>('/entitiesgroups')
      // Only custom-created groups (from the box's own graph agents). The
      // platform's built-in NER groups use ALL-CAPS codes (ORG, LOC, DATE...)
      // and are excluded from the portal's graph views.
      const names = Object.keys(raw.groups ?? {})
        .filter((name) => !/^[A-Z0-9_]+$/.test(name))
        .slice(0, 16)
      const out = await Promise.all(names.map(async (group) => {
        const inline = Object.keys(raw.groups?.[group]?.entities ?? {})
        if (inline.length > 0) return { group, entities: inline.slice(0, 100) }
        try {
          const detail = await client.getJson<{ entities?: Record<string, unknown> }>(
            `/entitiesgroup/${encodeURIComponent(group)}`,
          )
          return { group, entities: Object.keys(detail.entities ?? {}).slice(0, 100) }
        } catch {
          return { group, entities: [] }
        }
      }))
      return out.filter((g) => g.entities.length > 0)
    } catch {
      return []
    }
  }

  async deleteAgent(tenant: TenantConfig, id: string): Promise<void> {
    await this.client(tenant).dpJson('DELETE', `/task/${id}`)
  }

  /** Typed full content of a resource for the detail view. */
  async resourceContent(tenant: TenantConfig, id: string): Promise<ResourceContent | null> {
    let raw: RawResource & {
      icon?: string
      origin?: { url?: string }
      summary?: string
      data?: Record<
        string,
        Record<string, {
          value?: { body?: string; file?: { content_type?: string } }
          extracted?: {
            text?: { text?: string }
            metadata?: {
              metadata?: {
                paragraphs?: { start?: number; end?: number; start_seconds?: number[] }[]
              }
            }
          }
        }>
      >
    }
    try {
      raw = await this.client(tenant).getJson(
        `/resource/${id}?show=basic&show=origin&show=values&show=extracted&show=extra&extracted=text&extracted=metadata`,
      )
    } catch (err) {
      if (err instanceof AragApiError && err.status === 404) return null
      throw err
    }
    const icon = raw.icon ?? ''
    const texts: { fieldId: string; text: string }[] = []
    const files: { group: string; fieldId: string; contentType?: string }[] = []
    const transcript: { text: string; startSec?: number }[] = []
    for (const [group, fields] of Object.entries(raw.data ?? {})) {
      for (const [fieldId, field] of Object.entries(fields ?? {})) {
        // Prefer the authored body (a text field's original markdown, with its
        // real paragraph breaks and headings) over the platform's flattened
        // extracted text; fall back to extracted text for crawled links and
        // uploaded files, which have no authored body. See docs/ARAG-DEV.md on
        // the extracted text flattening markdown line breaks into whitespace.
        const text = field.value?.body ?? field.extracted?.text?.text ?? ''
        if (text.trim()) texts.push({ fieldId: `${group}/${fieldId}`, text })
        // Detect a downloadable file field by the presence of a stored file
        // value, not by the group name alone - the file-proxy route
        // (`/resource/{id}/file/{fieldId}/download/field`) resolves the bare
        // field id regardless of which data group it lives under.
        if (field.value?.file) {
          files.push({ group, fieldId, contentType: field.value.file.content_type })
        }
        const paragraphs = field.extracted?.metadata?.metadata?.paragraphs ?? []
        for (const p of paragraphs) {
          const startSec = Array.isArray(p.start_seconds) ? p.start_seconds[0] : undefined
          if (startSec === undefined) continue
          const chunk = text.slice(p.start ?? 0, p.end ?? 0).trim()
          if (chunk) transcript.push({ text: chunk, startSec })
        }
      }
    }
    const originUrl = raw.origin?.url
    const kind: ResourceContent['kind'] = detectContentKind({
      icon,
      isLink: Boolean(originUrl) && Object.keys(raw.data?.links ?? {}).length > 0,
      fileMimes: files.map((f) => f.contentType ?? ''),
    })
    const primaryFile = files[0]
    const preview = kind === 'office' ? selectPreviewFile(files, primaryFile?.fieldId) : undefined
    // The platform DA page-summary agent already wrote a real per-resource
    // summary (field `da-pagesummary-f-*`) at ingest - reuse it as the
    // merchandised summary source before any richer enrichment is generated.
    const pageSummary = extractPageSummary(texts)
    const rawSummary = raw.summary ||
      (raw.extra?.metadata as { summary?: string } | undefined)?.summary
    const safe = displayTitle(raw.title, id)
    const rawTitle = safe === 'Untitled resource' ? '' : (raw.title ?? '')
    const merch = baselineMerchandising(rawTitle, pageSummary || rawSummary)
    return {
      id,
      title: merch.title,
      kind,
      originUrl,
      summary: merch.summary,
      ...(pageSummary ? { pageSummary } : {}),
      ...(merch.sourceName ? { sourceName: merch.sourceName } : {}),
      texts,
      transcript,
      files,
      enriched: false,
      ...(preview ? { preview } : {}),
    }
  }

  /** Stream the platform-generated thumbnail for a resource, if any. */
  async thumbnailResponse(tenant: TenantConfig, id: string): Promise<Response | null> {
    const client = this.client(tenant)
    let raw: { thumbnail?: string }
    try {
      raw = await client.getJson<{ thumbnail?: string }>(`/resource/${id}?show=basic`)
    } catch {
      return null
    }
    const thumb = raw.thumbnail
    if (!thumb) return null
    // The platform returns a path like /kb/<id>/resource/<rid>/... - strip the
    // kb prefix since our client base already ends at /kb/<id>.
    const path = thumb.replace(/^\/kb\/[^/]+/, '')
    if (!path.startsWith('/')) return null
    try {
      return await client.fileResponse(path)
    } catch {
      return null
    }
  }

  /** Proxy a stored file field (range-aware) for inline rendering. */
  fileStream(tenant: TenantConfig, id: string, fieldId: string, range?: string) {
    return this.client(tenant).fileResponse(
      `/resource/${id}/file/${fieldId}/download/field`,
      range,
    )
  }

  async *ask(
    tenant: TenantConfig,
    query: string,
    opts: AskOptions = {},
  ): AsyncIterable<AskEvent> {
    const client = this.client(tenant)
    yield { type: 'stage', stage: 'preprocessing', status: 'started' }
    const catalogue = await this.listResources(tenant).catch(() => [] as ResourceSummary[])
    const byId = new Map(catalogue.map((r) => [r.id, r]))
    yield { type: 'stage', stage: 'preprocessing', status: 'completed' }
    yield { type: 'stage', stage: 'retrieval', status: 'started' }

    const body: Record<string, unknown> = {
      query,
      features: ['keyword', 'semantic'],
      citations: true,
      show: ['basic', 'origin'],
      search_configuration: 'portal-ask',
      // Cross-encoder reranking of the grounding candidates - verified live
      // (see the reranker note in docs/ARAG-DEV.md and search()'s comment
      // above). Pinned defensively: it is already the platform's default
      // when omitted, so this guards against that default changing rather
      // than being a new capability. Shed on a pre-emission 4xx below, same
      // as rag_strategies/search_configuration/rag_images_strategies.
      reranker: 'predict',
      // Nuclia's default RAG prompt answers "Not enough data to answer this."
      // as a guardrail even when relevant sources were retrieved - override it.
      prompt: {
        system: opts.systemPrompt?.trim() ||
          `You are a research analyst for ${tenant.branding.organisation}. Always answer the ` +
            'question using the provided context. Synthesise across sources even when the context ' +
            'is partial - surface what IS known and be specific. Never reply that there is not ' +
            'enough data, and never refuse, when any relevant context is present. Write clear, ' +
            'well-structured prose with Markdown, in Australian English. Cite evidence at claim ' +
            'level: after each factual claim, add a bracketed marker like [1] to show a citation ' +
            'belongs there. The number itself does not matter and does not need to be in any ' +
            'particular order - this application assigns the real, correctly-bound citation ' +
            "numbers itself from the platform's own source attribution, independently of " +
            'whatever you write here. If a statement is your inference rather than something the ' +
            'context states, mark it (inference). When the context ' +
            'contains conflicting, negative or nuanced findings (adverse observations, ' +
            'non-detections, disagreements between studies), state them explicitly with their ' +
            'specifics - a researcher needs the tension, never a smoothed summary.',
      },
    }
    if (opts.context && opts.context.length > 0) {
      // The app models turns as USER/AGENT; this deployment's /ask context
      // enum is NUCLIA | USER (422 otherwise) - translate at the boundary.
      body.context = opts.context.map((turn) => ({
        author: turn.author === 'AGENT' ? 'NUCLIA' : 'USER',
        text: turn.text,
      }))
    }
    if (opts.resourceId) body.resource_filters = [opts.resourceId]
    if (opts.topicIds && opts.topicIds.length > 0) {
      body.filters = opts.topicIds.map((t) => `/classification.labels/topic/${t}`)
    }
    // Agentic retrieval upgrades: widen grounding windows around each hit and
    // walk the knowledge graph from entities detected in the query (uses the
    // box's graph extraction agent). Degrades gracefully if unsupported.
    const strategies: Record<string, unknown>[] = opts.depth === 'deep'
      ? [{ name: 'full_resource' }]
      : [
        { name: 'neighbouring_paragraphs', before: 2, after: 2 },
        { name: 'graph_beta', hops: 2, agentic_graph_only: true },
      ]
    if (opts.prequeries && opts.prequeries.length > 0) {
      strategies.push({
        name: 'prequeries',
        queries: opts.prequeries.slice(0, 8).map((q) => ({
          request: { query: q, features: ['keyword', 'semantic'] },
          weight: 1,
        })),
      })
    }
    body.rag_strategies = strategies
    if (opts.images) {
      body.rag_images_strategies = [{ name: 'page_image' }, { name: 'tables' }]
    }

    let sources: ScoredResource[] = []
    const contextTexts: string[] = []
    let fullAnswer = ''
    let refusalPossible = true
    let generating = false
    let emitted = false
    // See MIN_REFUSAL_OVERRIDE_RELEVANCE: at most one retry when the model
    // refuses despite a genuinely relevant retrieved source - never more,
    // so a true out-of-corpus question (no strong source to trigger it)
    // refuses exactly as before.
    let refusalRetried = false
    // Raw citations-map entries accumulate across every `citations` NDJSON
    // item (the platform can stream them progressively). Binding only runs
    // once, on the complete map against the complete answer text - see
    // `spliceCitationMarkers` for why: offsets are only meaningful once both
    // are final.
    let citationsMapAccum: Record<string, unknown> = {}

    const toSources = (
      retrieved: Record<
        string,
        RawResource & {
          fields?: Record<
            string,
            { paragraphs?: Record<string, { score?: number; text?: string }> }
          >
        }
      >,
    ): ScoredResource[] =>
      Object.entries(retrieved).map(([id, raw]) => {
        let best = 0
        let passage: string | undefined
        let page: number | undefined
        for (const field of Object.values(raw.fields ?? {})) {
          for (const paragraph of Object.values(field.paragraphs ?? {})) {
            if (paragraph.text) contextTexts.push(paragraph.text)
            if ((paragraph.score ?? 0) >= best) {
              best = paragraph.score ?? 0
              passage = paragraph.text ?? passage
              page = (paragraph as { position?: { page_number?: number } }).position?.page_number
            }
          }
        }
        const reference = passage ? looksLikeReferenceChunk(passage) : false
        const shown = reference ? best * 0.4 : best
        return {
          ...(byId.get(id) ?? this.toSummary(id, raw)),
          // Same calibration as search: semantic scores pass through, BM25
          // squashes - a weak grounding source must LOOK weak.
          relevance: Math.round((shown <= 1 ? Math.max(0, shown) : shown / (shown + 2)) * 100) /
            100,
          citedCount: 0,
          matchedPassage: passage,
          ...(page ? { matchedPage: page } : {}),
          ...(reference ? { referenceChunk: true } : {}),
        }
      })

    // Transient 412/5xx "unknown generative exception" happens before any text
    // streams; retry up to 3 times then, but never after output has started.
    const MAX_ATTEMPTS = 3
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // A retried attempt starts clean - no half-accumulated answer, contexts
      // or citations from the failed one.
      if (attempt > 1) {
        sources = []
        contextTexts.length = 0
        fullAnswer = ''
        refusalPossible = true
        generating = false
        citationsMapAccum = {}
      }
      try {
        const res = await client.postStream('/ask', body, { 'x-show-consumption': 'true' })
        const learningId = res.headers.get('nuclia-learning-id')
        if (learningId) yield { type: 'learning', id: learningId }
        for await (const line of ndjson(res)) {
          const item = (line as { item?: { type?: string } & Record<string, unknown> }).item
          if (!item?.type) continue
          if (item.type === 'retrieval') {
            const results = item.results as { resources?: Record<string, RawResource> } | undefined
            sources = toSources(results?.resources ?? {})
            yield { type: 'sources', resources: sources }
            if (!generating) {
              generating = true
              yield { type: 'stage', stage: 'retrieval', status: 'completed' }
              yield { type: 'stage', stage: 'generating', status: 'started' }
            }
          } else if (item.type === 'answer' && typeof item.text === 'string') {
            if (!generating) {
              generating = true
              yield { type: 'stage', stage: 'retrieval', status: 'completed' }
              yield { type: 'stage', stage: 'generating', status: 'started' }
            }
            fullAnswer += item.text
            // Hold back the platform's bare guardrail refusal: buffer while
            // the answer is still a prefix of it, and swap in honest guidance
            // if that is all the model produced.
            if (refusalPossible) {
              const lowered = fullAnswer.replace(/\s+/g, ' ').trim().toLowerCase()
              // Keep buffering while the text is still a prefix of the
              // guardrail sentence, or is the full sentence with only a few
              // trailing characters - but the moment real content follows it,
              // release everything (the model refused then kept going). This
              // is a display-only heuristic to avoid flashing the bare
              // guardrail sentence mid-stream; the authoritative refused/
              // done.text decision below always re-checks the COMPLETE
              // answer with `isGuardrailRefusal`, so a chunk boundary this
              // heuristic guesses wrong on can never leak the guardrail
              // sentence into the client as if it were a real answer (BUG 2).
              if (
                REFUSAL_TEXT.startsWith(lowered) ||
                (lowered.startsWith(REFUSAL_TEXT) && lowered.length <= REFUSAL_TEXT.length + 12)
              ) {
                continue
              }
              refusalPossible = false
              emitted = true
              // Transient display only: strip whatever bracket markers the
              // model has written so far so nothing wrongly-bound is ever
              // shown mid-stream. The authoritative, correctly-bound text
              // (spliced from the platform's own char-offsets) replaces this
              // once generation and citation binding both finish - see the
              // `done` event below.
              yield { type: 'delta', text: stripInlineMarkers(fullAnswer) }
              continue
            }
            emitted = true
            yield { type: 'delta', text: stripInlineMarkers(item.text) }
          } else if (item.type === 'citations' && item.citations) {
            // Accumulate only - numbering and marker placement need the
            // complete map plus the complete answer text, computed once the
            // stream finishes (see spliceCitationMarkers below).
            citationsMapAccum = {
              ...citationsMapAccum,
              ...(item.citations as Record<string, unknown>),
            }
          } else if (item.type === 'metadata') {
            const tokens = item.tokens as { input?: number; output?: number } | undefined
            const timings = item.timings as
              | { generative_first_chunk?: number; generative_total?: number }
              | undefined
            if (tokens || timings) {
              yield {
                type: 'usage',
                inputTokens: tokens?.input ?? 0,
                outputTokens: tokens?.output ?? 0,
                firstChunkSec: timings?.generative_first_chunk,
                totalSec: timings?.generative_total,
              }
            }
          } else if (
            item.type === 'status' && typeof item.code === 'number' && item.code >= 400
          ) {
            yield { type: 'error', message: `Answer service returned status ${item.code}` }
            return
          }
        }
        // A configured ask that retrieved nothing looks exactly like an
        // off-corpus question - but a broken stored 'portal-ask' config
        // (seen live on admin-connected boxes) produces the same shape for
        // EVERY query. Nothing user-visible has streamed in that case, so
        // shed the named config once and ask again before accepting a
        // refusal. The deleted key cannot re-trigger this branch.
        if (
          sources.length === 0 && !emitted && body.search_configuration &&
          isGuardrailRefusal(fullAnswer) && attempt < MAX_ATTEMPTS
        ) {
          delete body.search_configuration
          continue
        }
        // Refusal-calibration fix: the model produced only the guardrail
        // sentence, but a genuinely relevant source WAS retrieved (above
        // MIN_REFUSAL_OVERRIDE_RELEVANCE) - this is the inconsistency a
        // rephrased question sails past. One retry with a firmer directive
        // before an honest refusal is accepted; never more than once, so a
        // true out-of-corpus question (nothing this relevant retrieved)
        // refuses exactly as before.
        if (
          isGuardrailRefusal(fullAnswer) && !refusalRetried && attempt < MAX_ATTEMPTS &&
          sources.some((s) => s.relevance >= MIN_REFUSAL_OVERRIDE_RELEVANCE)
        ) {
          refusalRetried = true
          const prompt = body.prompt as { system: string }
          body.prompt = {
            system: `${prompt.system} Relevant sources WERE retrieved for this exact question - ` +
              'you must not refuse or say there is not enough data; answer directly from the ' +
              'context provided.',
          }
          continue
        }
        // BUG 2/3: the guardrail refusal is detected against the COMPLETE
        // answer text via `isGuardrailRefusal` here - not the incremental
        // `refusalPossible` streaming heuristic above, which only decides
        // when to START showing delta text and can diverge from the final
        // text on an unlucky chunk boundary. This is the one place `refused`
        // and the reader-facing refusal message are decided, so `done.text`
        // (BUG 3) and the retry gates above always agree with it.
        let refused = false
        let refusalMessage: string | undefined
        if (isGuardrailRefusal(fullAnswer)) {
          // The model produced only the guardrail sentence - replace it with
          // guidance the reader can act on.
          refused = true
          fullAnswer = ''
          refusalMessage =
            "This portal's content does not hold enough relevant material to answer this " +
            'confidently. Try rephrasing the question, narrowing it to a topic, or browsing ' +
            'the Library to see what it covers.'
          yield { type: 'delta', text: refusalMessage }
          // A refusal must never carry the sources/citations retrieved for
          // it - they did not ground an answer, so showing them beside "not
          // enough data" reads as contradictory evidence (BUG 2). The
          // `sources` event already streamed during retrieval, before this
          // was known to be a refusal - this corrective empty one supersedes
          // it; every client here replaces its source list on `sources`
          // rather than appending, so this reliably clears it.
          if (sources.length > 0) yield { type: 'sources', resources: [] }
        }
        // Deterministic citation binding: only runs once, here, against the
        // COMPLETE answer text and the COMPLETE accumulated citations map -
        // both are only meaningful once generation has finished. Emits the
        // canonical Citation[] (evidence table + click-through targets) and
        // the corrected answer text (model's own [n] markers stripped,
        // authoritative markers spliced at the platform's char-offsets) so
        // every rendering of a given citation index agrees by construction.
        let boundText: string | undefined
        if (!refused && fullAnswer.trim()) {
          const bound = spliceCitationMarkers(
            fullAnswer,
            citationsMapAccum,
            // Both branches already resolve through toSummary/displayTitle,
            // so this never surfaces a raw hash - but a resource id absent
            // from both (never retrieved as a scored source) still needs a
            // clean fallback rather than citations.ts's own last-resort
            // `?? resourceId`.
            (resourceId) =>
              byId.get(resourceId)?.title ?? sources.find((s) => s.id === resourceId)?.title ??
                'Untitled resource',
          )
          for (const citation of bound.citations) {
            yield { type: 'citation', citation }
          }
          boundText = bound.text
        }
        yield { type: 'stage', stage: 'generating', status: 'completed' }
        yield { type: 'stage', stage: 'validating', status: 'started' }
        // REMi trust signal: score the finished answer against the full
        // retrieved context. Best effort with a hard time cap - the answer is
        // never held hostage by the scorer.
        if (fullAnswer.trim() && contextTexts.length > 0) {
          try {
            let capTimer: ReturnType<typeof setTimeout> | undefined
            const quality = await Promise.race([
              this.remi(tenant, {
                question: query,
                answer: fullAnswer,
                contexts: contextTexts,
              }),
              new Promise<null>((resolve) => {
                capTimer = setTimeout(() => resolve(null), 12000)
              }),
            ])
            clearTimeout(capTimer)
            if (quality) yield { type: 'quality', ...quality }
          } catch {
            // scoring unavailable - skip silently
          }
        }
        yield { type: 'stage', stage: 'validating', status: 'completed' }
        // BUG 3: done.text always carries the final answer text, refusal
        // included - a client that reads done.text as canonical (replacing
        // its accumulated streamed text, as the delta contract intends)
        // must get the honest refusal message here too, not nothing.
        const doneText = refused ? refusalMessage : boundText
        yield { type: 'done', refused, ...(doneText !== undefined ? { text: doneText } : {}) }
        return
      } catch (err) {
        const status = err instanceof AragApiError ? err.status : 0
        // A 4xx before any output usually means an optional capability
        // (graph strategy, reranker) is unsupported here - shed it and go
        // again. MAX_ATTEMPTS still bounds the loop, so this and the
        // attempt-count retries below can't run indefinitely together.
        if (
          !emitted && status >= 400 && status < 500 &&
          (body.rag_strategies || body.search_configuration || body.rag_images_strategies ||
            body.reranker)
        ) {
          delete body.rag_strategies
          delete body.search_configuration
          delete body.rag_images_strategies
          delete body.reranker
          continue
        }
        const retryable = status === 412 || status >= 500
        if (!emitted && retryable && attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, 700 * attempt))
          continue
        }
        yield {
          type: 'error',
          message: err instanceof Error ? err.message : 'The answer service is unavailable',
        }
        return
      }
    }
  }
}
