import { type FormEvent, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useOutletContext } from 'react-router-dom'
import type { GenerateKind, ResourceSummary } from '@research-portal/core'
import { generateArtifact } from '../api/client.ts'
import { EmptyState } from '../components/ui.tsx'
import type { TenantOutletContext } from './TenantLayout.tsx'

// ---------------------------------------------------------------------------
// Kind metadata - tab labels, placeholder guidance and the "what is this for"
// copy shown before anything has been generated.
// ---------------------------------------------------------------------------

type KindMeta = {
  id: GenerateKind
  label: string
  placeholder: string
  description: string
}

const KINDS: KindMeta[] = [
  {
    id: 'comparison',
    label: 'Comparison',
    placeholder: 'e.g. Compare controlled traffic farming with conventional tillage',
    description:
      'A side-by-side matrix that scores a handful of options against the dimensions that matter, grounded in the knowledge box.',
  },
  {
    id: 'briefing',
    label: 'Briefing',
    placeholder: 'e.g. Brief me on the current state of soil carbon measurement',
    description:
      'An executive briefing document - an overview, structured sections, and the key takeaways worth remembering.',
  },
  {
    id: 'timeline',
    label: 'Timeline',
    placeholder: 'e.g. Timeline of drought policy changes since 2015',
    description:
      'A chronological timeline of events drawn from the sources, oldest to most recent.',
  },
  {
    id: 'proscons',
    label: 'Pros and cons',
    placeholder: 'e.g. Pros and cons of adopting variable rate technology',
    description: 'A balanced pros and cons breakdown, with the rationale behind each point.',
  },
  {
    id: 'faq',
    label: 'FAQ',
    placeholder: 'e.g. Common questions about grain storage regulations',
    description: 'A set of frequently asked questions with grounded, source-backed answers.',
  },
  {
    id: 'assessment',
    label: 'Assessment',
    placeholder: 'e.g. Quiz me on the basics of integrated pest management',
    description: 'A short interactive quiz to test understanding of a topic, with explanations.',
  },
]

const KIND_BY_ID = new Map(KINDS.map((k) => [k.id, k]))

// ---------------------------------------------------------------------------
// Shapes returned per kind, and small defensive type guards. `object` arrives
// typed as `unknown` - never trust it blindly, fall back to raw JSON if the
// shape surprises us.
// ---------------------------------------------------------------------------

type Rating = { dimension: string; assessment: string }
type ComparisonItem = { name: string; ratings: Rating[] }
type ComparisonObject = { dimensions: string[]; items: ComparisonItem[] }

type BriefingSection = { heading: string; content: string }
type BriefingObject = {
  title: string
  executive_summary: string
  sections: BriefingSection[]
  key_takeaways: string[]
}

type TimelineEvent = { date: string; title: string; description: string }
type TimelineObject = { title: string; events: TimelineEvent[] }

type ProsConsPoint = { point: string; rationale: string }
type ProsConsObject = { subject: string; pros: ProsConsPoint[]; cons: ProsConsPoint[] }

type FaqEntry = { question: string; answer: string }
type FaqObject = { title: string; entries: FaqEntry[] }

type AssessmentQuestion = {
  question: string
  options: string[]
  correct_index: number
  explanation: string
  topic: string
}
type AssessmentObject = { questions: AssessmentQuestion[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isComparison(value: unknown): value is ComparisonObject {
  if (!isRecord(value) || !isStringArray(value.dimensions) || !Array.isArray(value.items)) {
    return false
  }
  return value.items.every(
    (item) =>
      isRecord(item) &&
      typeof item.name === 'string' &&
      Array.isArray(item.ratings) &&
      item.ratings.every(
        (r) => isRecord(r) && typeof r.dimension === 'string' && typeof r.assessment === 'string',
      ),
  )
}

function isBriefing(value: unknown): value is BriefingObject {
  if (
    !isRecord(value) ||
    typeof value.title !== 'string' ||
    typeof value.executive_summary !== 'string' ||
    !Array.isArray(value.sections) ||
    !isStringArray(value.key_takeaways)
  ) {
    return false
  }
  return value.sections.every(
    (s) => isRecord(s) && typeof s.heading === 'string' && typeof s.content === 'string',
  )
}

function isTimeline(value: unknown): value is TimelineObject {
  if (!isRecord(value) || typeof value.title !== 'string' || !Array.isArray(value.events)) {
    return false
  }
  return value.events.every(
    (e) =>
      isRecord(e) &&
      typeof e.date === 'string' &&
      typeof e.title === 'string' &&
      typeof e.description === 'string',
  )
}

function isProsConsPointArray(value: unknown): value is ProsConsPoint[] {
  return (
    Array.isArray(value) &&
    value.every(
      (p) => isRecord(p) && typeof p.point === 'string' && typeof p.rationale === 'string',
    )
  )
}

function isProsCons(value: unknown): value is ProsConsObject {
  return (
    isRecord(value) &&
    typeof value.subject === 'string' &&
    isProsConsPointArray(value.pros) &&
    isProsConsPointArray(value.cons)
  )
}

function isFaq(value: unknown): value is FaqObject {
  if (!isRecord(value) || typeof value.title !== 'string' || !Array.isArray(value.entries)) {
    return false
  }
  return value.entries.every(
    (e) => isRecord(e) && typeof e.question === 'string' && typeof e.answer === 'string',
  )
}

function isAssessment(value: unknown): value is AssessmentObject {
  if (!isRecord(value) || !Array.isArray(value.questions)) return false
  return value.questions.every(
    (q) =>
      isRecord(q) &&
      typeof q.question === 'string' &&
      isStringArray(q.options) &&
      typeof q.correct_index === 'number' &&
      typeof q.explanation === 'string' &&
      typeof q.topic === 'string',
  )
}

// ---------------------------------------------------------------------------
// Per-kind renderers
// ---------------------------------------------------------------------------

function ComparisonTable({ data }: { data: ComparisonObject }) {
  return (
    <div className='overflow-x-auto rounded-2xl border border-neutral-200 bg-white shadow-sm'>
      <table className='w-full min-w-[640px] border-collapse text-sm'>
        <thead>
          <tr>
            <th className='sticky left-0 bg-neutral-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500'>
              Dimension
            </th>
            {data.items.map((item) => (
              <th
                key={item.name}
                className='border-l border-neutral-100 bg-neutral-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500'
              >
                {item.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.dimensions.map((dim) => (
            <tr key={dim} className='border-t border-neutral-100'>
              <th
                scope='row'
                className='sticky left-0 bg-white px-4 py-3 text-left text-sm font-medium text-neutral-900'
              >
                {dim}
              </th>
              {data.items.map((item) => {
                const rating = item.ratings.find((r) => r.dimension === dim)
                return (
                  <td
                    key={item.name}
                    className='border-l border-neutral-100 px-4 py-3 align-top text-sm text-neutral-600'
                  >
                    {rating?.assessment ?? 'Not covered'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BriefingDoc({ data }: { data: BriefingObject }) {
  return (
    <div className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8'>
      <h2 className='text-xl font-semibold tracking-tight text-neutral-900'>{data.title}</h2>
      <p className='mt-3 text-sm leading-relaxed text-neutral-600'>{data.executive_summary}</p>

      {data.key_takeaways.length > 0 && (
        <div className='mt-5 rounded-xl bg-neutral-50 p-4'>
          <p className='text-xs font-semibold uppercase tracking-wide text-neutral-500'>
            Key takeaways
          </p>
          <ul className='mt-2 space-y-1.5'>
            {data.key_takeaways.map((t, i) => (
              <li key={i} className='flex gap-2 text-sm text-neutral-800'>
                <span aria-hidden='true' className='text-neutral-400'>&bull;</span>
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className='mt-6 space-y-5'>
        {data.sections.map((s, i) => (
          <div key={i}>
            <h3 className='text-sm font-semibold text-neutral-900'>{s.heading}</h3>
            <p className='mt-1.5 text-sm leading-relaxed text-neutral-600'>{s.content}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function TimelineView({ data }: { data: TimelineObject }) {
  return (
    <div className='rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm sm:p-8'>
      <h2 className='text-xl font-semibold tracking-tight text-neutral-900'>{data.title}</h2>
      <ol className='mt-6 space-y-6 border-l-2 border-neutral-200 pl-6'>
        {data.events.map((ev, i) => (
          <li key={i} className='relative'>
            <span
              className='absolute -left-[27px] top-1 h-3 w-3 rounded-full border-2 border-white'
              style={{ backgroundColor: 'var(--rp-accent)' }}
              aria-hidden='true'
            />
            <span className='inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-medium text-neutral-700'>
              {ev.date}
            </span>
            <h3 className='mt-1.5 text-sm font-semibold text-neutral-900'>{ev.title}</h3>
            <p className='mt-1 text-sm leading-relaxed text-neutral-600'>{ev.description}</p>
          </li>
        ))}
      </ol>
    </div>
  )
}

function ProsConsView({ data }: { data: ProsConsObject }) {
  return (
    <div>
      <h2 className='text-lg font-semibold tracking-tight text-neutral-900'>{data.subject}</h2>
      <div className='mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2'>
        <div className='rounded-2xl border border-emerald-200 bg-emerald-50 p-5'>
          <p className='text-xs font-semibold uppercase tracking-wide text-emerald-700'>Pros</p>
          <ul className='mt-3 space-y-3'>
            {data.pros.map((p, i) => (
              <li key={i}>
                <p className='text-sm font-medium text-emerald-900'>{p.point}</p>
                <p className='mt-0.5 text-sm text-emerald-800/80'>{p.rationale}</p>
              </li>
            ))}
          </ul>
          {data.pros.length === 0 && (
            <p className='mt-3 text-sm text-emerald-800/70'>
              None found.
            </p>
          )}
        </div>
        <div className='rounded-2xl border border-rose-200 bg-rose-50 p-5'>
          <p className='text-xs font-semibold uppercase tracking-wide text-rose-700'>Cons</p>
          <ul className='mt-3 space-y-3'>
            {data.cons.map((c, i) => (
              <li key={i}>
                <p className='text-sm font-medium text-rose-900'>{c.point}</p>
                <p className='mt-0.5 text-sm text-rose-800/80'>{c.rationale}</p>
              </li>
            ))}
          </ul>
          {data.cons.length === 0 && <p className='mt-3 text-sm text-rose-800/70'>None found.</p>}
        </div>
      </div>
    </div>
  )
}

function FaqView({ data }: { data: FaqObject }) {
  return (
    <div>
      <h2 className='text-lg font-semibold tracking-tight text-neutral-900'>{data.title}</h2>
      <div className='mt-4 space-y-2'>
        {data.entries.map((e, i) => (
          <details
            key={i}
            className='group rounded-xl border border-neutral-200 bg-white open:shadow-sm'
          >
            <summary className='flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-neutral-900 [&::-webkit-details-marker]:hidden'>
              {e.question}
              <span
                className='shrink-0 text-neutral-400 transition-transform duration-150 group-open:rotate-180'
                aria-hidden='true'
              >
                &#9662;
              </span>
            </summary>
            <div className='border-t border-neutral-100 px-4 py-3 text-sm leading-relaxed text-neutral-600'>
              {e.answer}
            </div>
          </details>
        ))}
      </div>
    </div>
  )
}

/** Interactive quiz - pick an answer per question, submit reveals correct/incorrect + a score. */
function AssessmentQuiz({ data }: { data: AssessmentObject }) {
  const [selected, setSelected] = useState<Record<number, number>>({})
  const [submitted, setSubmitted] = useState(false)

  const score = data.questions.reduce(
    (acc, q, i) => acc + (selected[i] === q.correct_index ? 1 : 0),
    0,
  )

  return (
    <div>
      <div className='flex items-center justify-between gap-3'>
        <h2 className='text-lg font-semibold tracking-tight text-neutral-900'>Assessment</h2>
        {submitted && (
          <p className='text-sm font-semibold text-neutral-900'>
            Score: {score} / {data.questions.length}
          </p>
        )}
      </div>

      <div className='mt-4 space-y-6'>
        {data.questions.map((q, qi) => (
          <div key={qi} className='rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm'>
            {q.topic && (
              <p className='text-xs font-semibold uppercase tracking-wide text-neutral-400'>
                {q.topic}
              </p>
            )}
            <p className='mt-1 text-sm font-medium text-neutral-900'>{q.question}</p>
            <div className='mt-3 space-y-2'>
              {q.options.map((opt, oi) => {
                const isChosen = selected[qi] === oi
                const isCorrect = oi === q.correct_index
                let cls = 'border-neutral-200 hover:border-neutral-300'
                if (submitted) {
                  if (isCorrect) {
                    cls = 'border-emerald-300 bg-emerald-50 text-emerald-900'
                  } else if (isChosen) {
                    cls = 'border-rose-300 bg-rose-50 text-rose-900'
                  }
                } else if (isChosen) {
                  cls = 'border-neutral-900'
                }
                return (
                  <button
                    key={oi}
                    type='button'
                    disabled={submitted}
                    onClick={() => setSelected((prev) => ({ ...prev, [qi]: oi }))}
                    className={`block w-full rounded-xl border px-4 py-2.5 text-left text-sm transition-colors duration-150 disabled:cursor-default ${cls}`}
                  >
                    {opt}
                  </button>
                )
              })}
            </div>
            {submitted && q.explanation && (
              <p className='mt-3 text-sm leading-relaxed text-neutral-600'>{q.explanation}</p>
            )}
          </div>
        ))}
      </div>

      {!submitted && data.questions.length > 0 && (
        <button
          type='button'
          onClick={() => setSubmitted(true)}
          className='mt-6 inline-flex items-center rounded-full px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150'
          style={{ backgroundColor: 'var(--rp-primary)' }}
        >
          Submit answers
        </button>
      )}
    </div>
  )
}

function RawFallback({ value }: { value: unknown }) {
  return (
    <div className='rounded-2xl border border-amber-200 bg-amber-50 p-4'>
      <p className='text-sm font-medium text-amber-800'>
        This result did not match the expected shape - showing the raw data instead.
      </p>
      <pre className='mt-3 max-h-96 overflow-auto rounded-xl bg-white p-4 text-xs text-neutral-700'>
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function SourcesRow({ sources }: { sources: ResourceSummary[] }) {
  return (
    <div className='mt-6 border-t border-neutral-100 pt-5'>
      <p className='text-xs font-semibold uppercase tracking-wide text-neutral-500'>
        Grounded in {sources.length} {sources.length === 1 ? 'source' : 'sources'}
      </p>
      {sources.length > 0 && (
        <div className='mt-2 flex flex-wrap gap-2'>
          {sources.map((s) => (
            <span
              key={s.id}
              title={s.title}
              className='max-w-[16rem] truncate rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs text-neutral-600'
            >
              {s.title}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ArtifactBody({ kind, object }: { kind: GenerateKind; object: unknown }) {
  switch (kind) {
    case 'comparison':
      return isComparison(object)
        ? <ComparisonTable data={object} />
        : <RawFallback value={object} />
    case 'briefing':
      return isBriefing(object) ? <BriefingDoc data={object} /> : <RawFallback value={object} />
    case 'timeline':
      return isTimeline(object) ? <TimelineView data={object} /> : <RawFallback value={object} />
    case 'proscons':
      return isProsCons(object) ? <ProsConsView data={object} /> : <RawFallback value={object} />
    case 'faq':
      return isFaq(object) ? <FaqView data={object} /> : <RawFallback value={object} />
    case 'assessment':
      return isAssessment(object)
        ? <AssessmentQuiz data={object} />
        : <RawFallback value={object} />
    default:
      return <RawFallback value={object} />
  }
}

// ---------------------------------------------------------------------------
// Export - serialise the current artifact to Word or a print-ready PDF view.
// One shared HTML serialiser mirrors the renderers above; both export paths
// build on top of it so the two documents always agree with what's on screen.
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Turns a generated artifact into a title plus a body of clean semantic HTML
 * (headings, paragraphs, tables, lists) - the shared source for both the
 * Word and PDF exports. All text content is escaped; nothing is interpolated
 * raw. Falls back to a formatted JSON dump if the object doesn't match the
 * expected shape for its kind, same as the on-screen renderer.
 */
function artifactToHtml(
  kind: GenerateKind,
  object: unknown,
  sourceTitles: string[],
): { title: string; bodyHtml: string } {
  let title = KIND_BY_ID.get(kind)?.label ?? 'Artifact'
  let contentHtml: string

  if (kind === 'comparison' && isComparison(object)) {
    title = 'Comparison'
    const headerCells = object.items.map((item) => `<th>${escapeHtml(item.name)}</th>`).join('')
    const rows = object.dimensions
      .map((dim) => {
        const cells = object.items
          .map((item) => {
            const rating = item.ratings.find((r) => r.dimension === dim)
            return `<td>${escapeHtml(rating?.assessment ?? 'Not covered')}</td>`
          })
          .join('')
        return `<tr><th scope="row">${escapeHtml(dim)}</th>${cells}</tr>`
      })
      .join('')
    contentHtml =
      `<table><thead><tr><th>Dimension</th>${headerCells}</tr></thead><tbody>${rows}</tbody></table>`
  } else if (kind === 'briefing' && isBriefing(object)) {
    title = object.title
    const takeaways = object.key_takeaways.length > 0
      ? `<h2>Key takeaways</h2><ul>${
        object.key_takeaways.map((t) => `<li>${escapeHtml(t)}</li>`).join('')
      }</ul>`
      : ''
    const sections = object.sections
      .map((s) => `<h2>${escapeHtml(s.heading)}</h2><p>${escapeHtml(s.content)}</p>`)
      .join('')
    contentHtml = `<p>${escapeHtml(object.executive_summary)}</p>${takeaways}${sections}`
  } else if (kind === 'timeline' && isTimeline(object)) {
    title = object.title
    contentHtml = `<ol>${
      object.events
        .map((ev) =>
          `<li><strong>${escapeHtml(ev.date)}:</strong> ${escapeHtml(ev.title)}<p>${
            escapeHtml(ev.description)
          }</p></li>`
        )
        .join('')
    }</ol>`
  } else if (kind === 'proscons' && isProsCons(object)) {
    title = object.subject
    const prosHtml = object.pros
      .map(
        (p) => `<li><strong>${escapeHtml(p.point)}</strong><p>${escapeHtml(p.rationale)}</p></li>`,
      )
      .join('')
    const consHtml = object.cons
      .map(
        (c) => `<li><strong>${escapeHtml(c.point)}</strong><p>${escapeHtml(c.rationale)}</p></li>`,
      )
      .join('')
    contentHtml = `<h2>Pros</h2><ul>${prosHtml || '<li>None found.</li>'}</ul>` +
      `<h2>Cons</h2><ul>${consHtml || '<li>None found.</li>'}</ul>`
  } else if (kind === 'faq' && isFaq(object)) {
    title = object.title
    contentHtml = object.entries
      .map((e) => `<h2>${escapeHtml(e.question)}</h2><p>${escapeHtml(e.answer)}</p>`)
      .join('')
  } else if (kind === 'assessment' && isAssessment(object)) {
    title = 'Assessment'
    contentHtml = object.questions
      .map((q, i) => {
        const options = q.options
          .map((opt, oi) =>
            `<li>${escapeHtml(opt)}${oi === q.correct_index ? ' (correct answer)' : ''}</li>`
          )
          .join('')
        const topic = q.topic ? `<p><em>${escapeHtml(q.topic)}</em></p>` : ''
        return `<h2>${i + 1}. ${
          escapeHtml(q.question)
        }</h2>${topic}<ol type="a">${options}</ol><p>${escapeHtml(q.explanation)}</p>`
      })
      .join('')
  } else {
    contentHtml = `<pre>${escapeHtml(JSON.stringify(object, null, 2))}</pre>`
  }

  const sourcesHtml =
    `<h2>Grounded in ${sourceTitles.length} ${
      sourceTitles.length === 1 ? 'source' : 'sources'
    }</h2>` +
    (sourceTitles.length > 0
      ? `<ul>${sourceTitles.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
      : '<p>No sources.</p>')

  return { title, bodyHtml: `${contentHtml}${sourcesHtml}` }
}

/** Word-compatible HTML document shell - opens cleanly as a .doc in Word. */
function wordDocumentHtml(title: string, bodyHtml: string): string {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<!--[if gte mso 9]>
<xml>
<w:WordDocument>
<w:View>Print</w:View>
<w:Zoom>100</w:Zoom>
<w:DoNotOptimizeForBrowser/>
</w:WordDocument>
</xml>
<![endif]-->
<style>
body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; line-height: 1.5; }
h1, h2, h3 { font-family: Arial, Helvetica, sans-serif; color: #111111; }
h1 { font-size: 22pt; margin-bottom: 12pt; }
h2 { font-size: 14pt; margin-top: 18pt; margin-bottom: 6pt; }
table { border-collapse: collapse; width: 100%; margin: 12pt 0; }
th, td { border: 1px solid #cccccc; padding: 6pt 8pt; text-align: left; font-size: 10pt; }
th { background: #f2f2f2; }
ul, ol { margin: 6pt 0; padding-left: 22pt; }
p { margin: 6pt 0; font-size: 11pt; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body>
</html>`
}

/** Standalone, print-optimised HTML - opened in a new window for the PDF export. */
function printDocumentHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
@page { size: A4; margin: 18mm 16mm; }
body { font-family: Georgia, 'Times New Roman', serif; color: #111111; background: #ffffff; line-height: 1.5; margin: 0; padding: 24px; }
h1, h2, h3 { font-family: Arial, Helvetica, sans-serif; color: #0a0a0a; }
h1 { font-size: 20pt; margin-bottom: 12pt; }
h2 { font-size: 13pt; margin-top: 16pt; margin-bottom: 6pt; }
table { border-collapse: collapse; width: 100%; margin: 12pt 0; page-break-inside: avoid; }
th, td { border: 1px solid #cccccc; padding: 6pt 8pt; text-align: left; font-size: 10pt; vertical-align: top; }
th { background: #f2f2f2; }
tr, li { page-break-inside: avoid; }
ul, ol { margin: 6pt 0; padding-left: 22pt; }
p { margin: 6pt 0; font-size: 11pt; }
@media print {
  body { padding: 0; }
  a { color: inherit; text-decoration: none; }
}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${bodyHtml}
</body>
</html>`
}

/** Filename-safe slug of a title, falling back to today's date when the title is empty. */
function slugOrDate(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
  return slug.length > 0 ? slug.slice(0, 60) : new Date().toISOString().slice(0, 10)
}

function exportToWord(kind: GenerateKind, object: unknown, sourceTitles: string[]) {
  const { title, bodyHtml } = artifactToHtml(kind, object, sourceTitles)
  const html = wordDocumentHtml(title, bodyHtml)
  const blob = new Blob(['﻿', html], { type: 'application/msword' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${kind}-${slugOrDate(title)}.doc`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/** Opens a print-ready view in a new window and triggers the browser's print dialog.
 * Returns false when the window could not be opened (popup blocked). */
function exportToPdf(kind: GenerateKind, object: unknown, sourceTitles: string[]): boolean {
  const { title, bodyHtml } = artifactToHtml(kind, object, sourceTitles)
  const html = printDocumentHtml(title, bodyHtml)
  const win = globalThis.open('', '_blank')
  if (!win) return false
  win.document.write(html)
  win.document.close()
  win.focus()
  setTimeout(() => win.print(), 250)
  return true
}

function ExportRow(
  { kind, object, sourceTitles }: { kind: GenerateKind; object: unknown; sourceTitles: string[] },
) {
  const [popupBlocked, setPopupBlocked] = useState(false)
  const disabled = object === undefined || object === null

  return (
    <div className='mt-4 flex flex-wrap items-center gap-3'>
      <button
        type='button'
        disabled={disabled}
        onClick={() => exportToWord(kind, object, sourceTitles)}
        className='inline-flex items-center rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors duration-150 hover:border-neutral-300 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60'
      >
        Export to Word
      </button>
      <button
        type='button'
        disabled={disabled}
        onClick={() => setPopupBlocked(!exportToPdf(kind, object, sourceTitles))}
        className='inline-flex items-center rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-700 transition-colors duration-150 hover:border-neutral-300 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60'
      >
        Export to PDF
      </button>
      {popupBlocked
        ? <p className='text-sm text-rose-600'>Allow pop-ups to export as PDF.</p>
        : null}
    </div>
  )
}

const EMPTY_DRAFTS: Record<GenerateKind, string> = {
  comparison: '',
  briefing: '',
  timeline: '',
  proscons: '',
  faq: '',
  assessment: '',
}

/**
 * Generate: schema-enforced research artifacts, grounded in the knowledge
 * box. Six kinds of artifact, each rendered with a purpose-built layout
 * rather than a generic document view.
 */
export function GeneratePage() {
  const { config } = useOutletContext<TenantOutletContext>()
  const [kind, setKind] = useState<GenerateKind>('comparison')
  const [drafts, setDrafts] = useState<Record<GenerateKind, string>>(EMPTY_DRAFTS)
  const [resultVersion, setResultVersion] = useState(0)

  const mutation = useMutation({
    mutationFn: (vars: { kind: GenerateKind; query: string }) =>
      generateArtifact(config.slug, vars.kind, vars.query),
    onSuccess: () => setResultVersion((v) => v + 1),
  })

  const activeMeta = KIND_BY_ID.get(kind) ?? KINDS[0]

  const selectKind = (next: GenerateKind) => {
    setKind(next)
    mutation.reset()
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    const query = drafts[kind].trim()
    if (!query) return
    mutation.mutate({ kind, query })
  }

  return (
    <main className='mx-auto max-w-4xl px-6 py-10'>
      <h1 className='text-2xl font-semibold tracking-tight text-neutral-900'>Generate</h1>
      <p className='mt-1 text-sm text-neutral-500'>
        Schema-enforced research artifacts, grounded in the knowledge box.
      </p>

      <div className='mt-6 inline-flex flex-wrap gap-1 rounded-full border border-neutral-200 bg-white p-1'>
        {KINDS.map((k) => (
          <button
            key={k.id}
            type='button'
            onClick={() => selectKind(k.id)}
            className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors duration-150 ${
              kind === k.id ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-100'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} className='mt-5'>
        <label
          htmlFor='generate-query'
          className='mb-1.5 block text-sm font-medium text-neutral-900'
        >
          What should the {activeMeta?.label.toLowerCase()} cover?
        </label>
        <textarea
          id='generate-query'
          rows={3}
          value={drafts[kind]}
          onChange={(e) => setDrafts((prev) => ({ ...prev, [kind]: e.target.value }))}
          placeholder={activeMeta?.placeholder}
          className='w-full rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-neutral-900'
        />
        <button
          type='submit'
          disabled={mutation.isPending || drafts[kind].trim().length === 0}
          className='mt-3 inline-flex items-center rounded-full px-5 py-2.5 text-sm font-medium text-white transition-colors duration-150 disabled:opacity-60'
          style={{ backgroundColor: 'var(--rp-primary)' }}
        >
          {mutation.isPending ? 'Generating - this can take up to half a minute…' : 'Generate'}
        </button>
      </form>

      {mutation.isError && (
        <div role='alert' className='mt-8 rounded-2xl border border-rose-200 bg-rose-50 p-6'>
          <p className='text-sm font-medium text-rose-900'>Generation failed</p>
          <p className='mt-1 text-sm text-rose-700'>
            {mutation.error instanceof Error
              ? mutation.error.message
              : 'Something went wrong - try a narrower request.'}
          </p>
        </div>
      )}

      {!mutation.data && !mutation.isError && !mutation.isPending && (
        <div className='mt-8'>
          <EmptyState
            title={`${activeMeta?.label} artifacts`}
            description={activeMeta?.description}
          />
        </div>
      )}

      {mutation.isPending && (
        <div className='mt-8 animate-pulse rounded-2xl border border-neutral-200 bg-white p-8'>
          <div className='h-4 w-1/3 rounded bg-neutral-200' />
          <div className='mt-4 h-3 w-full rounded bg-neutral-100' />
          <div className='mt-2 h-3 w-5/6 rounded bg-neutral-100' />
          <div className='mt-2 h-3 w-2/3 rounded bg-neutral-100' />
        </div>
      )}

      {mutation.data && !mutation.isPending && (
        <div className='mt-8'>
          <ArtifactBody
            key={resultVersion}
            kind={mutation.data.kind}
            object={mutation.data.object}
          />
          <ExportRow
            key={`export-${resultVersion}`}
            kind={mutation.data.kind}
            object={mutation.data.object}
            sourceTitles={mutation.data.sources.map((s) => s.title)}
          />
          <SourcesRow sources={mutation.data.sources} />
        </div>
      )}
    </main>
  )
}
