import { assessConfidence } from '../lib/confidence.ts'

const SEGMENTS = 5

export interface QualityScores {
  answerRelevance: number | null
  groundedness: number | null
  contextRelevance: number | null
}

const METRICS: { key: keyof QualityScores; label: string; description: string }[] = [
  {
    key: 'answerRelevance',
    label: 'Relevance',
    description: 'Answer relevance: how directly the answer addresses the question asked - ' +
      'scored automatically against the retrieved sources.',
  },
  {
    key: 'groundedness',
    label: 'Groundedness',
    description: 'Groundedness: how firmly the answer is supported by the retrieved material - ' +
      'scored automatically against the retrieved sources.',
  },
  {
    key: 'contextRelevance',
    label: 'Context',
    description: 'Context relevance: how well the retrieved passages match the question asked - ' +
      'scored automatically against the retrieved sources.',
  },
]

/** ok/warn/bad status band for a 0-5 REMi score. */
function bandColour(score: number): string {
  if (score >= 4) return 'var(--rp-ok-ink)'
  if (score >= 2.5) return 'var(--rp-warn-ink)'
  return 'var(--rp-bad-ink)'
}

function ShieldCheckIcon() {
  return (
    <svg
      viewBox='0 0 20 20'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.6'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      className='h-3.5 w-3.5 shrink-0'
    >
      <path d='M10 2.3l6.2 2.25v4.4c0 4.2-2.7 7.2-6.2 8.85-3.5-1.65-6.2-4.65-6.2-8.85v-4.4z' />
      <path d='M6.9 10.1l2 2 4-4.3' />
    </svg>
  )
}

function MiniMeter(
  { label, description, score }: { label: string; description: string; score: number },
) {
  const colour = bandColour(score)
  const filled = Math.round(Math.max(0, Math.min(SEGMENTS, score)))

  return (
    <span className='inline-flex items-center gap-1.5' title={description}>
      <span className='text-[10px] font-medium text-ink-3'>{label}</span>
      <span className='inline-flex items-center gap-[2px]' aria-hidden='true'>
        {Array.from({ length: SEGMENTS }).map((_, index) => (
          <span
            key={index}
            className='h-2 w-1 rounded-[1px]'
            style={{ backgroundColor: index < filled ? colour : 'var(--rp-surface-3)' }}
          />
        ))}
      </span>
      <span className='text-[10px] font-semibold tabular-nums' style={{ color: colour }}>
        {score.toFixed(1)}/5
      </span>
    </span>
  )
}

export interface TrustSignalsProps {
  quality: QualityScores
}

type PresentMetric = { key: keyof QualityScores; label: string; description: string; score: number }

/**
 * Compact inline row of REMi trust signals: a shield-check icon labelled
 * "Answer quality" followed by up to three five-segment mini-meters (answer
 * relevance, groundedness, context relevance). Each metric is coloured by its
 * own ok/warn/bad band and carries a one-sentence explanation in its title
 * attribute. A null metric is skipped; if every metric is null nothing renders.
 */
export function TrustSignals({ quality }: TrustSignalsProps) {
  const present: PresentMetric[] = []
  for (const metric of METRICS) {
    const score = quality[metric.key]
    if (score !== null) present.push({ ...metric, score })
  }

  if (present.length === 0) return null

  return (
    <div className='flex flex-wrap items-center gap-x-3 gap-y-1.5'>
      <span
        className={'inline-flex items-center gap-1 text-[10px] font-medium uppercase ' +
          'tracking-wide text-ink-3'}
      >
        <ShieldCheckIcon />
        Answer quality
      </span>
      {present.map((metric) => (
        <MiniMeter
          key={metric.key}
          label={metric.label}
          description={metric.description}
          score={metric.score}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Confidence indicator - the plain-language headline `TrustSignals` above
// supports. One component, four looks, all driven by `assessConfidence` (see
// apps/web/src/lib/confidence.ts) so this and the mini-meters never disagree.
// ---------------------------------------------------------------------------

function CheckCircleIcon() {
  return (
    <svg
      viewBox='0 0 20 20'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.7'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      className='h-3.5 w-3.5 shrink-0'
    >
      <circle cx='10' cy='10' r='7.25' />
      <path d='M6.8 10.1l2.1 2.1 4.3-4.4' />
    </svg>
  )
}

function InfoCircleIcon() {
  return (
    <svg
      viewBox='0 0 20 20'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.7'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      className='h-3.5 w-3.5 shrink-0'
    >
      <circle cx='10' cy='10' r='7.25' />
      <path d='M10 9.2v4' />
      <circle cx='10' cy='6.6' r='0.15' fill='currentColor' stroke='none' />
    </svg>
  )
}

function AlertTriangleIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      viewBox='0 0 20 20'
      fill='none'
      stroke='currentColor'
      strokeWidth='1.7'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
      className={`${className} shrink-0`}
    >
      <path d='M10 2.6l8.2 14.2a1 1 0 01-.87 1.5H2.67a1 1 0 01-.87-1.5L10 2.6z' />
      <path d='M10 8v3.6' />
      <circle cx='10' cy='14.2' r='0.15' fill='currentColor' stroke='none' />
    </svg>
  )
}

export interface ConfidenceIndicatorProps {
  quality: QualityScores | null | undefined
}

/**
 * The single, unmissable, plain-language answer-confidence signal - the
 * headline `TrustSignals`' detailed mini-meters support. Renders differently
 * per state so the visual weight matches how much a reader should worry:
 *
 *  - `unscored`: a quiet inline chip - honest about missing REMi rather than
 *    defaulting to a confident look.
 *  - `high`: a quiet positive chip - confirms without shouting.
 *  - `moderate`: a lighter caution callout.
 *  - `low`: THE key piece - a bold, bordered warning banner with
 *    `role="alert"` so assistive tech announces it immediately, an icon (not
 *    colour alone), and copy that explicitly points at the evidence below.
 */
export function ConfidenceIndicator({ quality }: ConfidenceIndicatorProps) {
  const confidence = assessConfidence(quality)

  if (confidence.state === 'unscored') {
    return (
      <span className='rp-badge rp-badge-quiet inline-flex items-center gap-1'>
        <InfoCircleIcon />
        Confidence not scored for this answer
      </span>
    )
  }

  if (confidence.state === 'high') {
    return (
      <span className='rp-badge rp-badge-ok inline-flex items-center gap-1'>
        <CheckCircleIcon />
        High confidence
      </span>
    )
  }

  if (confidence.state === 'moderate') {
    return (
      <div
        role='status'
        className='flex items-start gap-2 rounded-[var(--rp-radius)] border p-3'
        style={{ borderColor: 'var(--rp-warn-line)', background: 'var(--rp-warn-bg)' }}
      >
        <span className='mt-0.5 text-[var(--rp-warn-ink)]'>
          <AlertTriangleIcon className='h-3.5 w-3.5' />
        </span>
        <p className='text-xs leading-relaxed text-[var(--rp-warn-ink)]'>
          <strong className='font-semibold'>Moderate confidence.</strong>{' '}
          The retrieved sources only partly support this answer - check the citations before relying
          on it.
        </p>
      </div>
    )
  }

  return (
    <div
      role='alert'
      className='flex items-start gap-2.5 rounded-[var(--rp-radius)] border-2 p-3.5'
      style={{ borderColor: 'var(--rp-bad-line)', background: 'var(--rp-bad-bg)' }}
    >
      <span className='mt-0.5 text-[var(--rp-bad-ink)]'>
        <AlertTriangleIcon />
      </span>
      <p className='text-sm leading-relaxed text-[var(--rp-bad-ink)]'>
        <strong className='font-semibold'>Low confidence</strong>{' '}
        - the retrieved sources only weakly support this answer. Treat it as a lead and verify
        against the cited sources below.
      </p>
    </div>
  )
}
