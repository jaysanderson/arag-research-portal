import { expect } from '@std/expect'

// DATA_DIR is read at module load, so point it at a temp dir before importing.
const dir = await Deno.makeTempDir()
Deno.env.set('DATA_DIR', dir)
const { InsightsStore, SessionsStore, SourceStore, WatchStore } = await import('./stores.ts')

Deno.test('insights summary aggregates asks and surfaces gaps', () => {
  const store = new InsightsStore()
  const base = {
    ts: new Date().toISOString(),
    citations: 2,
    durationSec: 1.5,
    answerRelevance: 5,
    contextRelevance: 3,
  }
  store.record('t1', { ...base, question: 'What is X?', answered: true, groundedness: 5 })
  store.record('t1', { ...base, question: 'what is x', answered: true, groundedness: 4 })
  store.record('t1', {
    ...base,
    question: 'Unanswerable?',
    answered: false,
    citations: 0,
    groundedness: null,
  })
  const summary = store.summary('t1')
  expect(summary.totalAsks).toEqual(3)
  expect(summary.answered).toEqual(2)
  expect(summary.unanswered).toEqual(1)
  // Case and trailing punctuation collapse into one top question.
  expect(summary.topQuestions[0]!).toEqual({ question: 'what is x', count: 2 })
  expect(summary.gaps.length).toEqual(1)
  expect(summary.gaps[0]!.reason).toEqual('No answer found in the corpus')
  expect(summary.avgGroundedness).toEqual(4.5)
})

Deno.test('sessions are isolated per client and removable', () => {
  const store = new SessionsStore()
  const session = { id: 's1', title: 'Trail', updatedAt: '2026-01-01T00:00:00Z', messages: [] }
  store.put('t1', 'alice', session)
  expect(store.list('t1', 'alice').length).toEqual(1)
  expect(store.list('t1', 'bob').length).toEqual(0)
  expect(store.get('t1', 'bob', 's1')).toEqual(null)
  store.remove('t1', 'alice', 's1')
  expect(store.list('t1', 'alice').length).toEqual(0)
})

Deno.test('watches flag changes only after a baseline exists', () => {
  const store = new WatchStore()
  const watch = store.add('t1', 'alice', 'carp control')
  expect(store.list('t1', 'alice')[0]!.changed).toEqual(false)
  // First run establishes the baseline fingerprint.
  store.update('t1', watch.id, { fingerprint: 'a|b', changed: false })
  // A later differing fingerprint marks the watch changed until seen.
  const before = store.list('t1')[0]!
  store.update('t1', watch.id, {
    changed: before.fingerprint !== null && before.fingerprint !== 'a|c',
    fingerprint: 'a|c',
  })
  expect(store.list('t1', 'alice')[0]!.changed).toEqual(true)
  store.remove('t1', 'bob', watch.id)
  expect(store.list('t1', 'alice').length).toEqual(1)
  store.remove('t1', 'alice', watch.id)
  expect(store.list('t1', 'alice').length).toEqual(0)
})

Deno.test('sources dedupe by url and persist sync bookkeeping', () => {
  const store = new SourceStore()
  const source = store.add('t1', 'https://example.org', true)
  const duplicate = store.add('t1', 'https://example.org', true)
  expect(duplicate.id).toEqual(source.id)
  store.update('t1', source.id, { lastAdded: 5, synced: ['https://example.org/a'] })
  expect(store.list('t1')[0]!.lastAdded).toEqual(5)
  store.remove('t1', source.id)
  expect(store.list('t1').length).toEqual(0)
})
