import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { type EvidenceVerdict, getSourceVerdicts } from '../api/client.ts'
import { citationHref } from './AnswerStream.tsx'
import { SaveEvidenceButton } from './SaveEvidence.tsx'

// ---------------------------------------------------------------------------
// Evidence table - the persistent, scannable record of "what did we actually
// retrieve, and does it hold up" that sits under every answer. It replaces
// the Journey modal's per-source AI relevance judgement (good idea, but
// ephemeral - gone the moment the modal closes) with a static table anyone
// can scan without playing a walk-through, and a one-click "Save" straight
// into an investigation's evidence log.
// ---------------------------------------------------------------------------

/** Cap on how many sources get an AI verdict in one call - keeps the judge call fast. */
const MAX_JUDGED = 8

export interface EvidenceSource {
  id: string
  title: string
  /** The passage the retrieval matched, when known. Falls back to the title as the saved passage. */
  passage?: string
  /** Retrieval relevance in [0, 1], rendered as a percentage. */
  score?: number | null
}

export interface EvidenceVerdictInfo {
  verdict: string
  /** One-line AI sentence on how this source relates to the question. */
  relevance: string
}

const VERDICT_BADGE_CLASS: Record<string, string> = {
  supports: 'rp-badge-ok',
  partial: 'rp-badge-warn',
  contradicts: 'rp-badge-bad',
  'not-relevant': 'rp-badge-quiet',
}

const VERDICT_LABEL: Record<string, string> = {
  supports: 'Supports',
  partial: 'Partial',
  contradicts: 'Contradicts',
  'not-relevant': 'Not relevant',
}

function verdictBadgeClass(verdict: string): string {
  return VERDICT_BADGE_CLASS[verdict] ?? 'rp-badge-quiet'
}

function verdictLabel(verdict: string): string {
  return VERDICT_LABEL[verdict] ?? verdict
}

/** One row: a retrieved source, its match strength, its AI verdict, and a save action. */
function EvidenceRow({
  slug,
  question,
  source,
  verdict,
  judging,
}: {
  slug: string
  question: string
  source: EvidenceSource
  verdict?: EvidenceVerdictInfo
  judging: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const passage = source.passage?.trim() || undefined
  const scorePct = typeof source.score === 'number' ? Math.round(source.score * 100) : null
  const isWeak = scorePct !== null && scorePct < 35

  return (
    <div className='rounded-[var(--rp-radius)] border border-line bg-surface-2 p-3'>
      <div className='flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5'>
        <Link
          to={citationHref(slug, source.id, passage)}
          className='rp-clamp-2 min-w-0 flex-1 text-sm font-medium text-ink underline-offset-2 hover:underline'
        >
          {source.title}
        </Link>
        <div className='flex shrink-0 flex-wrap items-center gap-1.5'>
          {scorePct !== null
            ? <span className='text-xs tabular-nums text-ink-3'>{scorePct}%</span>
            : null}
          {isWeak ? <span className='rp-badge rp-badge-warn'>weak match</span> : null}
          {judging
            ? (
              <span
                className='rp-shimmer h-[18px] w-16 rounded-[4px] bg-surface-3'
                aria-hidden='true'
              />
            )
            : verdict
            ? (
              <span className={`rp-badge ${verdictBadgeClass(verdict.verdict)}`}>
                {verdictLabel(verdict.verdict)}
              </span>
            )
            : null}
        </div>
      </div>

      {passage
        ? (
          <p
            className={`mt-1.5 text-xs leading-relaxed text-ink-2 ${expanded ? '' : 'rp-clamp-2'}`}
          >
            {passage}
          </p>
        )
        : null}
      {passage && passage.length > 140
        ? (
          <button
            type='button'
            onClick={() => setExpanded((prev) => !prev)}
            className='mt-1 text-xs font-medium text-[var(--rp-accent)]'
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )
        : null}

      {judging
        ? (
          <div
            className='mt-1.5 h-3 w-3/4 rounded-[4px] rp-shimmer bg-surface-3'
            aria-hidden='true'
          />
        )
        : verdict?.relevance
        ? <p className='mt-1.5 text-xs italic text-ink-3'>{verdict.relevance}</p>
        : null}

      <div className='mt-2 flex justify-end'>
        <SaveEvidenceButton
          slug={slug}
          compact
          evidence={{
            passage: passage || source.title,
            resourceId: source.id,
            resourceTitle: source.title,
            score: source.score ?? undefined,
            question,
            verdict: (verdict?.verdict as EvidenceVerdict | undefined) ?? undefined,
            aiRelevance: verdict?.relevance,
          }}
        />
      </div>
    </div>
  )
}

export interface EvidenceTableProps {
  slug: string
  question: string
  sources: EvidenceSource[]
  /** Verdicts already known (e.g. reloaded from a saved message) - skips the judge call entirely. */
  initialVerdicts?: Record<string, EvidenceVerdictInfo>
  /** Fires once new verdicts arrive from the judge call, so the parent can persist them. */
  onVerdicts?: (verdicts: Record<string, EvidenceVerdictInfo>) => void
  /** Set false to never call the judge - used for the "closest passages" view under a refusal. */
  judge?: boolean
  /** Header label - defaults to "Evidence", overridable for e.g. "Closest passages found". */
  title?: string
}

/**
 * Persistent, scannable record of every source behind an answer: title,
 * matched passage, retrieval score, an AI verdict on whether it actually
 * supports the answer, and a one-click save into an investigation. Static -
 * nothing autoplays. When mounted without `initialVerdicts` it asks the
 * platform to judge each source once (capped at eight, only those with a
 * passage) and shows a quiet shimmer per row while that call is in flight;
 * a failed judge call just leaves rows without a verdict rather than erroring.
 */
export function EvidenceTable({
  slug,
  question,
  sources,
  initialVerdicts,
  onVerdicts,
  judge = true,
  title = 'Evidence',
}: EvidenceTableProps) {
  const [verdicts, setVerdicts] = useState<Record<string, EvidenceVerdictInfo>>(
    initialVerdicts ?? {},
  )
  const [judgingIds, setJudgingIds] = useState<Set<string>>(new Set())
  const onVerdictsRef = useRef(onVerdicts)
  onVerdictsRef.current = onVerdicts

  useEffect(() => {
    if (!judge || initialVerdicts !== undefined) return
    const candidates = sources
      .filter((source) => (source.passage ?? '').trim().length > 0)
      .slice(0, MAX_JUDGED)
    if (candidates.length === 0) return

    let cancelled = false
    setJudgingIds(new Set(candidates.map((source) => source.id)))

    getSourceVerdicts(
      slug,
      question,
      candidates.map((source) => ({
        id: source.id,
        title: source.title,
        passage: (source.passage ?? '').trim(),
      })),
    )
      .then((result) => {
        if (cancelled) return
        const next: Record<string, EvidenceVerdictInfo> = {}
        for (const item of result.verdicts) {
          next[item.id] = { verdict: item.verdict, relevance: item.relevance }
        }
        setVerdicts((prev) => {
          const merged = { ...prev, ...next }
          onVerdictsRef.current?.(merged)
          return merged
        })
      })
      .catch(() => {
        // Judging is advisory - a failure just leaves rows without a verdict.
      })
      .finally(() => {
        if (!cancelled) setJudgingIds(new Set())
      })

    return () => {
      cancelled = true
    }
    // Runs once on mount only: the answer this table describes never changes
    // under it, so re-running on every prop identity change would re-fire
    // the judge call for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (sources.length === 0) return null

  return (
    <div>
      <div className='flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1'>
        <h3 className='text-xs font-semibold uppercase tracking-wide text-ink-3'>
          {title}: {sources.length}
        </h3>
        <p className='text-[11px] text-ink-3'>
          AI verdicts are advisory - open a source to judge for yourself.
        </p>
      </div>
      <div className='mt-2 space-y-2'>
        {sources.map((source) => (
          <EvidenceRow
            key={source.id}
            slug={slug}
            question={question}
            source={source}
            verdict={verdicts[source.id]}
            judging={judgingIds.has(source.id) && !verdicts[source.id]}
          />
        ))}
      </div>
    </div>
  )
}
