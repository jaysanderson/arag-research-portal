import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import type { KgImplementEvent, KgProposal, TenantConfig } from '@research-portal/core'
import { KgProposalSchema } from '@research-portal/core'
import type { AragProvider } from '@research-portal/retrieval'

/**
 * Knowledge-graph strategy: interrogate the corpus, have the box's own model
 * design a graph strategy (entity types for extraction, resource-level and
 * chunk-level label taxonomies), SUGGEST it to the user, and on approval
 * implement it as data-augmentation agents on the box - which then run over
 * existing resources and/or every future ingest.
 */

const KG_SCHEMA = {
  name: 'knowledge_graph_strategy',
  description: 'Design a knowledge graph and labelling strategy for this corpus',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      rationale: { type: 'string' },
      entityTypes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { label: { type: 'string' }, description: { type: 'string' } },
          required: ['label', 'description'],
        },
      },
      resourceLabels: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { label: { type: 'string' }, description: { type: 'string' } },
          required: ['label', 'description'],
        },
      },
      chunkLabels: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { label: { type: 'string' }, description: { type: 'string' } },
          required: ['label', 'description'],
        },
      },
    },
    required: ['rationale', 'entityTypes', 'resourceLabels', 'chunkLabels'],
  },
}

/** Last proposal per tenant, persisted so implement can follow a restart. */
export class KgProposalStore {
  private proposals: Record<string, KgProposal> = {}
  private readonly path: string

  constructor(env: Record<string, string | undefined> = process.env) {
    this.path = env.KG_PROPOSALS_PATH ?? './data/kg-proposals.json'
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>
      for (const [slug, value] of Object.entries(raw)) {
        const parsed = KgProposalSchema.safeParse(value)
        if (parsed.success) this.proposals[slug] = parsed.data
      }
    } catch {
      this.proposals = {}
    }
  }

  get(slug: string): KgProposal | undefined {
    return this.proposals[slug]
  }

  set(slug: string, proposal: KgProposal): void {
    this.proposals[slug] = proposal
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.proposals, null, 2))
  }
}

export async function proposeKgStrategy(
  management: AragProvider,
  config: TenantConfig,
): Promise<KgProposal> {
  const resources = await management.listResources(config)
  if (resources.length === 0) {
    throw new Error('The knowledge box has no indexed content yet - add some resources first.')
  }
  const inventory = resources
    .slice(0, 80)
    .map((r, i) => `${i + 1}. ${r.title} - ${r.summary.slice(0, 150)}`)
    .join('\n')
  const prompt =
    `You are designing a knowledge-graph strategy for this knowledge box. Corpus inventory ` +
    `(${resources.length} resources):\n\n${inventory}\n\n` +
    `Design: (1) 4 to 7 entity types an extraction agent should pull from this corpus (label ` +
    `in Title Case plus a one-line description of what qualifies, e.g. people, organisations, ` +
    `species, programs, regions, technologies - whatever fits THIS corpus); (2) 4 to 8 ` +
    `resource-level labels (whole-document classifications) with descriptions; (3) 4 to 8 ` +
    `chunk-level labels (classifying individual passages, e.g. finding, recommendation, ` +
    `statistic, definition, methodology) with descriptions; (4) a two-sentence rationale ` +
    `explaining the strategy in Australian English. Labels in Title Case, no punctuation in ` +
    `labels.`
  const { object } = await management.askStructured(config, KG_SCHEMA, prompt)
  return KgProposalSchema.parse(object)
}

export async function* implementKgStrategy(
  management: AragProvider,
  config: TenantConfig,
  proposal: KgProposal,
  opts: { applyExisting: boolean; includeSummaries: boolean },
): AsyncGenerator<KgImplementEvent> {
  yield { type: 'stage', label: 'Resolving the box generative model' }
  const model = await management.generativeModel(config)
  yield {
    type: 'item',
    label: model ? `Model pinned: ${model}` : 'No model configured - using the platform default',
  }

  const slugify = (raw: string) =>
    raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

  yield { type: 'stage', label: 'Creating label taxonomies' }
  try {
    await management.createLabelset(config, {
      id: 'auto-labels',
      title: 'Document labels',
      multiple: true,
      labels: proposal.resourceLabels.map((l) => l.label),
      kind: 'RESOURCES',
    })
    yield { type: 'item', label: `Resource labelset created (${proposal.resourceLabels.length})` }
  } catch {
    yield { type: 'item', label: 'Resource labelset already exists - reusing' }
  }
  try {
    await management.createLabelset(config, {
      id: 'chunk-labels',
      title: 'Passage labels',
      multiple: true,
      labels: proposal.chunkLabels.map((l) => l.label),
      kind: 'PARAGRAPHS',
    })
    yield { type: 'item', label: `Chunk labelset created (${proposal.chunkLabels.length})` }
  } catch {
    yield { type: 'item', label: 'Chunk labelset already exists - reusing' }
  }

  yield { type: 'stage', label: 'Registering agents on the knowledge box' }
  let agents = 0
  const tryStart = async function* (
    label: string,
    task: string,
    title: string,
    operations: unknown[],
  ): AsyncGenerator<KgImplementEvent> {
    try {
      await management.startAgent(config, {
        task,
        title,
        operations,
        applyExisting: opts.applyExisting,
        model,
      })
      agents += 1
      yield { type: 'item', label: `${label} agent registered` }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed'
      if (/already running/i.test(message)) {
        // The platform runs one labelling agent at a time, and a rejected
        // concurrent start can leave a zombie config - clean it up.
        try {
          const zombie = (await management.listAgents(config)).find((a) => a.title === title)
          if (zombie) await management.deleteAgent(config, zombie.id)
        } catch {
          // best effort
        }
        yield {
          type: 'item',
          label:
            `${label} deferred - the platform runs one labelling agent at a time. Re-run ` +
            'Implement once the document labeller has finished to register it.',
        }
      } else {
        yield {
          type: 'item',
          label: `${label} agent was rejected by the platform`,
          detail: message.slice(0, 180),
        }
      }
    }
  }

  yield* tryStart('Knowledge graph', 'llm-graph', `kg-${slugify(config.slug)}`, [{
    graph: {
      ident: 'kg1',
      entity_defs: proposal.entityTypes.map((e) => ({
        label: e.label,
        description: e.description,
      })),
    },
  }])
  yield* tryStart('Document labeller', 'labeler', `labels-${slugify(config.slug)}`, [{
    label: {
      ident: 'kgl1',
      labels: proposal.resourceLabels.map((l) => ({
        label: l.label,
        description: l.description,
      })),
    },
  }])
  yield* tryStart('Passage labeller', 'labeler', `chunks-${slugify(config.slug)}`, [{
    label: {
      ident: 'kgl2',
      labels: proposal.chunkLabels.map((l) => ({
        label: l.label,
        description: l.description,
      })),
    },
  }])
  if (opts.includeSummaries) {
    yield* tryStart('Page summary generator', 'ask', `summaries-${slugify(config.slug)}`, [{
      ask: {
        question:
          'Write a three sentence, plain-language summary of this resource for a research portal card. Australian English.',
        destination: 'pagesummary',
      },
    }])
  }

  if (agents === 0) {
    yield { type: 'error', message: 'The platform rejected every agent - nothing was registered.' }
    return
  }
  yield {
    type: 'item',
    label: opts.applyExisting
      ? 'Agents will run over existing resources and every future ingest'
      : 'Agents will run on future ingests only',
  }
  yield { type: 'done', agents }
}
