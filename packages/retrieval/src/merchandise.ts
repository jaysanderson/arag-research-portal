import {
  DEFAULT_RESEARCH_ENRICHMENT,
  type Enrichment,
  enrichmentList,
  enrichmentString,
} from '@research-portal/core'

/**
 * Merchandising: turn a raw platform resource (whose "title" is often just a
 * filename or project code like "1981-071-DLD.pdf") into display fields no
 * surface should ever show as a bare filename. Two stages, sharing one set of
 * rules so provider and API can never disagree:
 *  1. a BASELINE from the raw title/summary alone (cleaned fallback title, raw
 *     name kept as muted secondary), applied by the provider on every resource;
 *  2. an OVERLAY of a generated enrichment's title/summary/takeaways/quotes,
 *     applied by the API from its own enrichment store when one exists.
 * All pure, so the selection + fallback logic is unit-tested directly.
 */

/** Whether a title reads as a raw filename or opaque project code, not a human title. */
export function looksLikeFilenameTitle(title: string): boolean {
  const t = title.trim()
  if (!t) return false
  // A trailing file extension (.pdf, .docx, .html, ...).
  if (/\.[a-z0-9]{2,5}$/i.test(t)) return true
  // A bare project code: 1981-071, 2003-067-DLD, 2018-190-DLD etc.
  if (/^\d{4}-\d{2,3}(-[A-Za-z0-9]{1,6})?$/.test(t)) return true
  return false
}

/**
 * The raw source name to keep as muted secondary metadata (the original
 * filename/code), or undefined when the raw title already reads as a real
 * human title and there is nothing to demote.
 */
export function sourceNameFor(rawTitle: string | undefined): string | undefined {
  const t = (rawTitle ?? '').trim()
  if (!t) return undefined
  return looksLikeFilenameTitle(t) ? t : undefined
}

/**
 * A cleaned, human-readable fallback title from a filename/code, used ONLY
 * until a real enrichment is generated. Never worse than the raw name: strips
 * the file extension, formats a known FRDC-style project code as "Project
 * NNNN-NNN", and tidies separators otherwise.
 */
export function fallbackTitle(rawTitle: string): string {
  const stripped = rawTitle.trim().replace(/\.[a-z0-9]{2,5}$/i, '')
  const code = /^(\d{4})-(\d{2,3})(?:-[A-Za-z0-9]{1,6})?$/.exec(stripped)
  if (code) return `Project ${code[1]}-${code[2]}`
  const tidied = stripped.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return tidied || rawTitle.trim() || 'Untitled resource'
}

/** The merchandised display fields produced by the two-stage pipeline. */
export interface Merchandised {
  title: string
  summary: string
  sourceName?: string
  keyTakeaways?: string[]
  quotesOfInterest?: string[]
  enriched: boolean
}

/**
 * Stage 1: baseline merchandising from the raw title/summary alone, with no
 * enrichment yet. A filename title becomes a cleaned fallback and the raw name
 * is demoted to `sourceName`; a summary that is merely the filename is dropped.
 */
export function baselineMerchandising(
  rawTitle: string | undefined,
  rawSummary: string | undefined,
): Merchandised {
  const raw = (rawTitle ?? '').trim()
  const src = sourceNameFor(raw)
  const title = src ? fallbackTitle(raw) : (raw || 'Untitled resource')
  const rawSum = (rawSummary ?? '').trim()
  // A raw summary equal to the filename (or to the raw title) carries nothing.
  const usableRawSum = rawSum && rawSum !== raw && rawSum !== (src ?? '') ? rawSum : ''
  return {
    title,
    summary: usableRawSum || title,
    ...(src ? { sourceName: src } : {}),
    enriched: false,
  }
}

/**
 * Stage 2: overlay a generated enrichment onto a baseline-merchandised item.
 * The enrichment's title/summary win when present; its key takeaways and
 * quotes are attached. Reading is programmatic (by field kind), so a Phase 2
 * agent with different keys flows through unchanged. With no enrichment the
 * baseline is returned untouched.
 */
export function overlayEnrichment(
  base: Merchandised,
  enrichment: Enrichment | undefined,
): Merchandised {
  if (!enrichment) return base
  const agent = DEFAULT_RESEARCH_ENRICHMENT
  const title = enrichmentString(agent, enrichment.data, 'title')
  const summary = enrichmentString(agent, enrichment.data, 'summary')
  const keyTakeaways = enrichmentList(agent, enrichment.data, 'list')
  const quotesOfInterest = enrichmentList(agent, enrichment.data, 'quotes')
  return {
    title: title || base.title,
    summary: summary || base.summary,
    ...(base.sourceName ? { sourceName: base.sourceName } : {}),
    ...(keyTakeaways.length ? { keyTakeaways } : {}),
    ...(quotesOfInterest.length ? { quotesOfInterest } : {}),
    enriched: Boolean(title),
  }
}

/**
 * The platform DA "page summary" agent writes a real per-resource summary to a
 * field id shaped `da-<destination>-f-<fieldId>` (e.g. `da-pagesummary-f-file`)
 * - work already paid for at ingest. Find that field's text among a resource's
 * extracted texts so it can seed the merchandised summary before any richer
 * enrichment is generated. Matches any DA summary destination, not just the
 * exact name, so a renamed agent still resolves.
 */
export function extractPageSummary(
  texts: { fieldId: string; text: string }[],
): string | undefined {
  const hit = texts.find((t) => /(^|\/)da-[a-z0-9]*summary[a-z0-9]*-f-/i.test(t.fieldId))
  const text = hit?.text?.trim()
  return text && text.length > 0 ? text : undefined
}
