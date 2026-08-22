import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { KgImplementEvent, KgProposal } from '@research-portal/core'
import { deleteAgent, getAgents, implementKg, proposeKg } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

const TASK_STYLE: Record<string, string> = {
  'llm-graph': 'bg-amber-50 text-amber-800 ring-amber-200',
  labeler: 'bg-sky-50 text-sky-800 ring-sky-200',
  ask: 'bg-violet-50 text-violet-800 ring-violet-200',
}
const DEFAULT_TASK_STYLE = 'bg-neutral-100 text-neutral-600 ring-neutral-200'

function ChipGroup({
  title,
  items,
}: {
  title: string
  items: { label: string; description: string }[]
}) {
  if (items.length === 0) return null
  return (
    <div>
      <p className='text-xs font-medium uppercase tracking-wide text-neutral-500'>{title}</p>
      <div className='mt-1.5 flex flex-wrap gap-1.5'>
        {items.map((item) => (
          <span
            key={item.label}
            title={item.description}
            className='inline-flex items-center rounded-full border border-neutral-200 bg-white px-2.5 py-0.5 text-xs font-medium text-neutral-700'
          >
            {item.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Knowledge-graph strategy workflow: interrogate the corpus, propose an
 * entity/label strategy for review, implement it as agents on the box, and
 * manage the agents once installed. `open` should reflect whether the
 * surrounding Intelligence section is visible, so the agents list is only
 * fetched while it can actually be seen.
 */
export function KgPanel(
  { slug, passcode, open }: { slug: string; passcode: string; open: boolean },
) {
  const queryClient = useQueryClient()
  const [proposing, setProposing] = useState(false)
  const [proposal, setProposal] = useState<KgProposal | null>(null)
  const [applyExisting, setApplyExisting] = useState(true)
  const [includeSummaries, setIncludeSummaries] = useState(true)
  const [implementing, setImplementing] = useState(false)
  const [log, setLog] = useState<KgImplementEvent[]>([])
  const [message, setMessage] = useState<Message | null>(null)

  const agentsQuery = useQuery({
    queryKey: ['kb-agents', slug],
    queryFn: () => getAgents(slug, passcode),
    enabled: open,
  })

  const onPropose = async () => {
    setProposing(true)
    setMessage(null)
    try {
      const result = await proposeKg(slug, passcode)
      setProposal(result)
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Could not propose a strategy - please try again.'),
      })
    } finally {
      setProposing(false)
    }
  }

  const onImplement = async () => {
    setImplementing(true)
    setLog([])
    setMessage(null)
    try {
      await implementKg(slug, passcode, { applyExisting, includeSummaries }, (event) => {
        setLog((prev) => [...prev, event])
        if (event.type === 'done') {
          setMessage({
            tone: 'ok',
            text: `Strategy implemented - ${event.agents} ${
              event.agents === 1 ? 'agent' : 'agents'
            } installed on the box.`,
          })
        }
        if (event.type === 'error') setMessage({ tone: 'error', text: event.message })
      })
      await queryClient.invalidateQueries({ queryKey: ['kb-agents', slug] })
    } catch (err) {
      setMessage({
        tone: 'error',
        text: errorMessage(err, 'Implementation failed - please retry.'),
      })
    } finally {
      setImplementing(false)
    }
  }

  const onRemoveAgent = async (taskId: string) => {
    setMessage(null)
    try {
      await deleteAgent(slug, passcode, taskId)
      await queryClient.invalidateQueries({ queryKey: ['kb-agents', slug] })
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Could not remove the agent.') })
    }
  }

  const agents = agentsQuery.data ?? []

  return (
    <div className='mt-5 rounded-xl border border-neutral-200 bg-neutral-50 p-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <p className='text-sm font-semibold text-neutral-900'>Knowledge graph</p>
          <p className='mt-0.5 text-xs text-neutral-500'>
            Interrogates the corpus, designs a knowledge-graph strategy, and - once you approve it -
            installs it as agents on the box.
          </p>
        </div>
        <button
          type='button'
          disabled={proposing}
          onClick={() => void onPropose()}
          className='inline-flex items-center rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors duration-150 hover:bg-neutral-800 disabled:opacity-60'
        >
          {proposing ? 'Interrogating the corpus…' : 'Propose strategy'}
        </button>
      </div>

      {proposal && (
        <div className='mt-4 space-y-3 rounded-lg border border-neutral-200 bg-white p-4'>
          <p className='text-sm text-neutral-700'>{proposal.rationale}</p>

          <ChipGroup title='Entity types' items={proposal.entityTypes} />
          <ChipGroup title='Document labels' items={proposal.resourceLabels} />
          <ChipGroup title='Passage labels' items={proposal.chunkLabels} />

          <div className='flex flex-wrap items-center gap-4 border-t border-neutral-100 pt-3'>
            <label className='flex items-center gap-2 text-sm text-neutral-700'>
              <input
                type='checkbox'
                checked={applyExisting}
                onChange={(e) => setApplyExisting(e.target.checked)}
              />
              Run over existing resources
            </label>
            <label className='flex items-center gap-2 text-sm text-neutral-700'>
              <input
                type='checkbox'
                checked={includeSummaries}
                onChange={(e) => setIncludeSummaries(e.target.checked)}
              />
              Generate page summaries
            </label>
          </div>

          <button
            type='button'
            disabled={implementing}
            onClick={() => void onImplement()}
            className='inline-flex items-center rounded-full px-4 py-2 text-sm font-medium text-white transition-opacity duration-150 disabled:opacity-60'
            style={{ backgroundColor: '#27364b' }}
          >
            {implementing ? 'Implementing…' : 'Implement strategy'}
          </button>

          {log.length > 0 && (
            <ol className='max-h-56 space-y-1 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-3 text-xs'>
              {log.map((event, index) => (
                <li key={index} className='flex gap-2'>
                  {event.type === 'stage' && (
                    <span className='font-semibold text-neutral-900'>{event.label}</span>
                  )}
                  {event.type === 'item' && (
                    <span className='text-neutral-600' title={event.detail}>
                      {event.label}
                    </span>
                  )}
                  {event.type === 'done' && (
                    <span className='font-medium text-emerald-700'>Finished.</span>
                  )}
                  {event.type === 'error' && <span className='text-rose-700'>{event.message}</span>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {message && <MessagePanel message={message} className='mt-3' />}

      <div className='mt-4 border-t border-neutral-200 pt-3'>
        <p className='text-sm font-medium text-neutral-900'>Agents on this box</p>

        {open && agentsQuery.isLoading && <p className='mt-2 text-sm text-neutral-500'>Loading…</p>}

        {agentsQuery.isError && (
          <p className='mt-2 text-sm text-neutral-500'>Could not load agents.</p>
        )}

        {open && !agentsQuery.isLoading && !agentsQuery.isError && agents.length === 0 && (
          <p className='mt-2 text-sm text-neutral-500'>
            No agents yet - propose a strategy above.
          </p>
        )}

        {agents.length > 0 && (
          <ul className='mt-2 divide-y divide-neutral-100 overflow-hidden rounded-xl border border-neutral-200'>
            {agents.map((agent) => (
              <li
                key={agent.id}
                className='flex items-center justify-between gap-3 bg-white px-4 py-2.5'
              >
                <span className='flex min-w-0 items-center gap-2.5'>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                      TASK_STYLE[agent.task] ?? DEFAULT_TASK_STYLE
                    }`}
                  >
                    {agent.task}
                  </span>
                  <span className='truncate text-sm text-neutral-900'>{agent.title}</span>
                </span>
                <button
                  type='button'
                  onClick={() => void onRemoveAgent(agent.id)}
                  className='shrink-0 text-sm font-medium text-rose-500 transition-colors duration-150 hover:text-rose-700'
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
