import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import type { TenantConfig } from '@research-portal/core'
import { AragProvider } from './index.ts'

/**
 * `relationsGraph()` defaults to agent-extracted relations only - the
 * built-in NER pipeline (PERSON/DATE/LOC groups) floods the path index and
 * would drown the curated graph. The Graph page now offers an opt-in
 * "include built-in entities" toggle (`includeBuiltin: true`) that drops the
 * `generated` filter so the raw NER output comes through too, while the
 * label-assignment-path and raw-resource-id-node exclusions still apply
 * regardless of mode - those are never useful entities.
 */

const TENANT: TenantConfig = {
  slug: 'frdc',
  branding: {
    productName: 'FRDC Research Portal',
    organisation: 'FRDC',
    tagline: 'Fisheries research, cited.',
    colours: { primary: '#000', accent: '#111', heroFrom: '#222', heroTo: '#333' },
  },
  searchPlaceholder: 'Search',
  topics: [],
  suggestedQuestions: [],
  entityTypes: [],
  relationTypes: [],
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

// A mix of relation kinds: one ordinary entity-entity relation (always kept),
// one built-in-NER relation (kept only with includeBuiltin), one
// label-assignment path (always excluded) and one raw resource-id node
// (always excluded).
const PATHS = [
  {
    source: { value: 'Abalone', group: 'Species' },
    relation: { label: 'affects' },
    destination: { value: 'Southern Fishery', group: 'Location' },
  },
  {
    source: { value: 'Dr Jane Smith', group: 'PERSON' },
    relation: { label: 'mentions' },
    destination: { value: 'Abalone', group: 'Species' },
  },
  {
    source: { value: 'Abalone', group: 'Species' },
    relation: { label: 'labelled' },
    destination: { value: 'topic/abalone', group: 'LABEL' },
  },
  {
    source: { value: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4', group: 'RESOURCE' },
    relation: { label: 'about' },
    destination: { value: 'Abalone', group: 'Species' },
  },
]

/** Provider whose /graph fetch always returns PATHS, capturing each request body. */
function providerCapturingGraphRequests(bodies: unknown[]): AragProvider {
  return new AragProvider({
    resolveBinding: () => ({
      baseUrl: 'https://test.rag.progress.cloud/api/v1/kb/test-kb',
      token: 'test-token',
    }),
    fetchImpl: (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/graph')) {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined)
        return Promise.resolve(jsonResponse({ paths: PATHS }))
      }
      throw new Error(`unexpected fetch to ${url}`)
    },
  })
}

describe('relationsGraph - includeBuiltin toggle', () => {
  it('default (includeBuiltin absent) queries with the generated filter and excludes NER groups', async () => {
    const bodies: unknown[] = []
    const provider = providerCapturingGraphRequests(bodies)
    const result = await provider.relationsGraph(TENANT)

    expect(bodies[0]).toEqual({
      query: { prop: 'generated', by: 'data-augmentation' },
      top_k: 400,
    })
    const ids = result.nodes.map((n) => n.id)
    expect(ids).toContain('Abalone')
    expect(ids).not.toContain('Dr Jane Smith')
    expect(ids).not.toContain('topic/abalone')
    expect(ids).not.toContain('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')
  })

  it('default with an entity keeps the generated filter alongside the path filter', async () => {
    const bodies: unknown[] = []
    const provider = providerCapturingGraphRequests(bodies)
    await provider.relationsGraph(TENANT, { entity: 'Abalone' })

    expect(bodies[0]).toEqual({
      query: {
        and: [
          { prop: 'path', source: { value: 'Abalone', match: 'exact' }, undirected: true },
          { prop: 'generated', by: 'data-augmentation' },
        ],
      },
      top_k: 400,
    })
  })

  it('includeBuiltin:true drops the generated filter, asking for all paths when there is no entity', async () => {
    const bodies: unknown[] = []
    const provider = providerCapturingGraphRequests(bodies)
    const result = await provider.relationsGraph(TENANT, { includeBuiltin: true })

    // The /graph endpoint 422s on a missing/empty query, so "everything" is an
    // explicit all-paths query (verified live).
    expect(bodies[0]).toEqual({ query: { prop: 'path' }, top_k: 400 })

    const ids = result.nodes.map((n) => n.id)
    // Built-in NER relation now included.
    expect(ids).toContain('Dr Jane Smith')
    expect(ids).toContain('Abalone')
    // Still excluded regardless of mode.
    expect(ids).not.toContain('topic/abalone')
    expect(ids).not.toContain('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')
  })

  it('includeBuiltin:true with an entity keeps only the path filter (no generated conjunct)', async () => {
    const bodies: unknown[] = []
    const provider = providerCapturingGraphRequests(bodies)
    await provider.relationsGraph(TENANT, { entity: 'Abalone', includeBuiltin: true })

    expect(bodies[0]).toEqual({
      query: { prop: 'path', source: { value: 'Abalone', match: 'exact' }, undirected: true },
      top_k: 400,
    })
  })
})
