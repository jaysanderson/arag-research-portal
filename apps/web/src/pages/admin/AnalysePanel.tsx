import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { AnalyseEvent } from '@research-portal/core'
import { analysePortal } from '../../api/client.ts'
import { MessagePanel } from './MessagePanel.tsx'
import { errorMessage, type Message } from './shared.ts'

/**
 * Interrogate the knowledge box: the system reads the corpus, designs the
 * topic taxonomy, the graph dimensions and the suggested questions, and
 * applies all of it - live progress below.
 */
export function AnalysePanel({ slug, passcode }: { slug: string; passcode: string }) {
  const queryClient = useQueryClient()
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<AnalyseEvent[]>([])
  const [message, setMessage] = useState<Message | null>(null)

  const run = async () => {
    setRunning(true)
    setLog([])
    setMessage(null)
    try {
      await analysePortal(slug, passcode, (event) => {
        setLog((prev) => [...prev, event])
        if (event.type === 'done') {
          setMessage({
            tone: 'ok',
            text: `Analysis complete - ${event.topics} topics, ${event.kinds} kinds, ` +
              `${event.labelled} resources labelled, ${event.questions} suggested questions. ` +
              'The portal now reflects what is in the box.',
          })
        }
        if (event.type === 'error') setMessage({ tone: 'error', text: event.message })
      })
      await queryClient.invalidateQueries()
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'Analysis failed - please retry.') })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className='mt-5 rounded-xl border border-neutral-200 bg-neutral-50 p-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <p className='text-sm font-semibold text-neutral-900'>Analyse and configure</p>
          <p className='mt-0.5 text-xs text-neutral-500'>
            Interrogates the box and derives the taxonomy, graph dimensions and suggested questions
            from what is actually in it.
          </p>
        </div>
        <button
          type='button'
          disabled={running}
          onClick={run}
          className='inline-flex items-center rounded-full px-4 py-2 text-sm font-medium text-white transition-opacity duration-150 disabled:opacity-60'
          style={{ backgroundColor: '#27364b' }}
        >
          {running ? 'Analysing…' : 'Run analysis'}
        </button>
      </div>

      {log.length > 0 && (
        <ol className='mt-3 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-3 text-xs'>
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
      {message && <MessagePanel message={message} className='mt-3' />}
    </div>
  )
}
