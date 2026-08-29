/**
 * Currency / staleness guard for grounded AI answers.
 *
 * THE PROBLEM this solves: the research corpora are largely historical (FRDC/GRDC
 * documents from the 1970s onward). An answer can confidently state a fact that
 * WAS true when its sources were written but is no longer current - and to a
 * research scientist one confidently-stale answer is disqualifying. So every
 * grounded answer carries an honest, calibrated recency signal derived purely
 * from the years of the sources it actually rests on:
 *
 *  1. a quiet, always-shown recency line (the date span of the cited sources); and
 *  2. a single honest caveat, shown ONLY when the newest cited source is older
 *     than `CURRENCY_CAVEAT_MAX_AGE_YEARS`.
 *
 * This is deliberately a pure function over the sources the retrieval provider
 * already returns - no new coupling to any LLM or vector store. The caller
 * decides which sources count (the ones actually cited / grounded on) and passes
 * them in; this module reads only their published year.
 */

/**
 * How old (in years) the newest cited source may be before the answer carries a
 * currency caveat. Named so it can be tuned in one place. Eight years is the
 * starting point: long enough not to nag on merely-recent research, short enough
 * to flag an answer whose freshest source predates a scientist's "current" view
 * of a fast-moving field.
 */
export const CURRENCY_CAVEAT_MAX_AGE_YEARS = 8

/** The single field this guard reads: a source's ISO publication date, when known. */
export interface CurrencySource {
  /** ISO date the source was published (e.g. "1998" or "1998-06-01"), when known. */
  published?: string
}

export interface CurrencySpan {
  /** Oldest cited-source year. */
  earliest: number
  /** Newest cited-source year. */
  latest: number
}

export interface CurrencySignal {
  /**
   * The year span of the cited sources that carry a year. Absent when NOT ONE
   * cited source has a usable year - in which case the guard shows nothing
   * rather than guessing.
   */
  span?: CurrencySpan
  /** The newest cited-source year, or undefined when none carry a year. */
  mostRecentYear?: number
  /** How many cited sources contributed a usable year. */
  datedCount: number
  /**
   * The quiet, always-shown recency line, e.g. "Sources: 1971-1998" or, when a
   * single year is present, "Most recent source: 1998". Absent when no cited
   * source carries a year.
   */
  recencyLabel?: string
  /** True only when the newest cited source is older than the caveat threshold. */
  showCaveat: boolean
  /**
   * The one honest caveat line, present only when `showCaveat` is true. Calibrated
   * and specific to this answer's newest source - not boilerplate.
   */
  caveatText?: string
}

/**
 * Extracts a four-digit publication year (1800-2099) from an ISO-ish date string.
 * Handles a bare year ("1998"), a full ISO date ("1998-06-01") and a year sitting
 * inside other text. Returns undefined when no plausible year is present, so a
 * source with no or unparseable date is simply excluded from the span.
 */
export function yearOf(published: string | undefined): number | undefined {
  if (!published) return undefined
  const match = /(?:^|\D)(1[89]\d{2}|20\d{2})(?:\D|$)/.exec(published)
  return match ? Number(match[1]) : undefined
}

/** The recency line copy for a computed span (single year vs a range). */
function recencyLabelFor(span: CurrencySpan): string {
  return span.earliest === span.latest
    ? `Most recent source: ${span.latest}`
    : `Sources: ${span.earliest}-${span.latest}`
}

/**
 * Assesses the currency of an answer from the sources it is grounded on.
 *
 * Reads only each source's published year. Sources with no usable year are
 * excluded from the span (they cannot make the answer look fresher OR staler).
 * When NO source carries a year, the result is silent (`recencyLabel`, `span`
 * and `mostRecentYear` all absent, `showCaveat` false) so nothing is shown.
 *
 * The caveat fires when the newest dated source is STRICTLY older than
 * `CURRENCY_CAVEAT_MAX_AGE_YEARS` - so an eight-year-old source (at the default
 * threshold) does not trip it, a nine-year-old one does.
 *
 * `now` (the current year) is a parameter so the boundary is deterministically
 * testable; it defaults to the real current year.
 */
export function assessCurrency(
  sources: readonly CurrencySource[],
  now: number = new Date().getFullYear(),
): CurrencySignal {
  const years: number[] = []
  for (const source of sources) {
    const year = yearOf(source.published)
    if (year !== undefined) years.push(year)
  }

  if (years.length === 0) {
    return { datedCount: 0, showCaveat: false }
  }

  const span: CurrencySpan = { earliest: Math.min(...years), latest: Math.max(...years) }
  const mostRecentYear = span.latest
  const showCaveat = now - mostRecentYear > CURRENCY_CAVEAT_MAX_AGE_YEARS

  return {
    span,
    mostRecentYear,
    datedCount: years.length,
    recencyLabel: recencyLabelFor(span),
    showCaveat,
    ...(showCaveat
      ? {
        caveatText:
          `This answer draws on sources up to ${mostRecentYear} and may not reflect developments since.`,
      }
      : {}),
  }
}
