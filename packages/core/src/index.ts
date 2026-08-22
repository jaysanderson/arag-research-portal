import { z } from 'zod'

// ---------------------------------------------------------------------------
// Tenant configuration - the single document that drives the whole portal UI.
// ---------------------------------------------------------------------------

export const BrandingSchema = z.object({
  /** Own-system product name, e.g. "GrainsIQ Research Portal" - never vendor branding. */
  productName: z.string().min(1),
  organisation: z.string().min(1),
  tagline: z.string().min(1),
  colours: z.object({
    /** All values are CSS colours. */
    primary: z.string(),
    accent: z.string(),
    heroFrom: z.string(),
    heroTo: z.string(),
  }),
  /** Served when an administrator uploaded a logo for this portal. */
  logoUrl: z.string().optional(),
  /** Served when an administrator uploaded a hero image for this portal. */
  heroImageUrl: z.string().optional(),
})

export const TopicSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
})

export const QuestionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
})

export const EntityTypeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  colour: z.string(),
})

export const TenantSummarySchema = z.object({
  slug: z.string().min(1),
  organisation: z.string().min(1),
  productName: z.string().min(1),
  tagline: z.string().min(1),
})

export const TenantConfigSchema = z.object({
  slug: z.string().min(1),
  branding: BrandingSchema,
  searchPlaceholder: z.string(),
  topics: TopicSchema.array(),
  suggestedQuestions: QuestionSchema.array(),
  entityTypes: EntityTypeSchema.array(),
  relationTypes: z.string().array(),
})

// ---------------------------------------------------------------------------
// Knowledge box connection status - which backing store a tenant is wired to.
// "demo" = the seeded demo knowledge box shipped with the app; "connected" =
// a knowledge box an administrator connected in the app; "none" = not wired.
// Never carries credentials.
// ---------------------------------------------------------------------------

export const KnowledgeBoxStatusSchema = z.object({
  slug: z.string().min(1),
  status: z.enum(['demo', 'connected', 'none']),
  /** Truncated knowledge box id for display - never the token. */
  kbId: z.string().optional(),
})

/** One row of the admin overview - everything the admin screen shows per tenant. */
export const AdminTenantOverviewSchema = z.object({
  tenant: TenantSummarySchema,
  knowledgeBox: KnowledgeBoxStatusSchema,
  /** Documents currently visible in the bound knowledge box; null when unreachable. */
  resourceCount: z.number().int().nonnegative().nullable(),
  /** True for portals added in-app (removable), false for the seeded pair. */
  custom: z.boolean().optional(),
  /** True when the portal is hidden from the switcher and portal list. */
  disabled: z.boolean().optional(),
})

/** Live knowledge box counters, straight from the platform's /counters. */
export const KbCountersSchema = z.object({
  resources: z.number().int().nonnegative(),
  paragraphs: z.number().int().nonnegative(),
  sentences: z.number().int().nonnegative(),
  indexMb: z.number().nonnegative(),
})

/** A recently added resource with its live processing state. */
export const RecentResourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['pending', 'processed', 'error']),
  created: z.string().optional(),
  /** Draft resources are hidden from searchers until published. */
  hidden: z.boolean().optional(),
})

/** Progress events streamed by corpus analysis (interrogate the box, derive
 * taxonomy + graph strategy + questions, and apply them). */
export const AnalyseEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stage'), label: z.string() }),
  z.object({ type: z.literal('item'), label: z.string(), detail: z.string().optional() }),
  z.object({
    type: z.literal('done'),
    topics: z.number().int().nonnegative(),
    kinds: z.number().int().nonnegative(),
    labelled: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

/** Progress events streamed by the knowledge-box migration tool. */
export const MigrationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), total: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('item'),
    id: z.string(),
    title: z.string(),
    outcome: z.enum(['copied', 'skipped-exists', 'skipped-unsupported', 'error']),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal('done'),
    copied: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

// ---------------------------------------------------------------------------
// Resources - documents, videos and web pages in the tenant's corpus.
// ---------------------------------------------------------------------------

export const ResourceTypeSchema = z.enum(['document', 'pdf', 'video', 'web'])

export const ResourceSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  type: ResourceTypeSchema,
  topicIds: z.string().array(),
  keyFacts: z.string().array(),
  /** ISO date the source was published, when known. */
  published: z.string().optional(),
})

export const ScoredResourceSchema = ResourceSummarySchema.extend({
  /** Retrieval relevance in [0, 1]. */
  relevance: z.number().min(0).max(1),
  /** How many citations in the current answer point at this resource. */
  citedCount: z.number().int().nonnegative().default(0),
  matchedPassage: z.string().optional(),
})

export const SearchResultsSchema = z.object({
  query: z.string(),
  resources: ScoredResourceSchema.array(),
  relatedQuestions: QuestionSchema.array(),
})

export const RetrievalModeSchema = z.enum(['hybrid', 'semantic', 'keyword'])

/** One page of the tenant's catalogue (the Library view). */
export const CatalogItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(['pending', 'processed', 'error']),
  created: z.string().optional(),
  topicIds: z.string().array(),
})

export const CatalogPageSchema = z.object({
  items: CatalogItemSchema.array(),
  total: z.number().int().nonnegative(),
})

/** A taxonomy category (labelset) with its labels. */
export const LabelsetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  multiple: z.boolean(),
  labels: z.string().array(),
})

/** Facet counts: labelset id -> label -> count of resources carrying it. */
export const FacetCountsSchema = z.record(z.string(), z.record(z.string(), z.number()))

/** Label co-occurrence graph (the reference portal's knowledge-graph model). */
export const GraphDataSchema = z.object({
  primary: z.string(),
  secondary: z.string(),
  nodes: z
    .object({
      id: z.string(),
      label: z.string(),
      group: z.enum(['primary', 'secondary']),
      weight: z.number().nonnegative(),
    })
    .array(),
  edges: z
    .object({ source: z.string(), target: z.string(), weight: z.number().nonnegative() })
    .array(),
})

/** Grounded, schema-enforced artifact kinds the Generate surface offers. */
export const GenerateKindSchema = z.enum([
  'comparison',
  'briefing',
  'timeline',
  'proscons',
  'faq',
  'assessment',
])

export const GenerateResultSchema = z.object({
  kind: GenerateKindSchema,
  object: z.unknown(),
  sources: z.lazy(() => ResourceSummarySchema.array()),
})

/** Full typed content of one resource, for the type-aware detail view. */
export const ResourceContentSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(['web', 'pdf', 'video', 'audio', 'image', 'text', 'file']),
  originUrl: z.string().optional(),
  summary: z.string().optional(),
  /** Extracted text per field. */
  texts: z.object({ fieldId: z.string(), text: z.string() }).array(),
  /** Timed transcript segments when the platform extracted timings. */
  transcript: z
    .object({ text: z.string(), startSec: z.number().nonnegative().optional() })
    .array(),
  /** Streamable file fields (group/field for the proxy route). */
  files: z
    .object({ group: z.string(), fieldId: z.string(), contentType: z.string().optional() })
    .array(),
})

/** A data-augmentation agent registered on the knowledge box. */
export const KbAgentSchema = z.object({
  id: z.string(),
  task: z.string(),
  title: z.string(),
})

/** The proposed knowledge-graph strategy, shown to the user before implementing. */
export const KgProposalSchema = z.object({
  rationale: z.string(),
  entityTypes: z.object({ label: z.string(), description: z.string() }).array(),
  resourceLabels: z.object({ label: z.string(), description: z.string() }).array(),
  chunkLabels: z.object({ label: z.string(), description: z.string() }).array(),
  /** Few-shot NER examples so the graph agent learns entity RELATIONS too. */
  examples: z
    .object({
      text: z.string(),
      entities: z.object({ name: z.string(), label: z.string() }).array(),
      relations: z
        .object({ source: z.string(), target: z.string(), label: z.string() })
        .array(),
    })
    .array()
    .default([]),
})

export const KgImplementEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stage'), label: z.string() }),
  z.object({ type: z.literal('item'), label: z.string(), detail: z.string().optional() }),
  z.object({ type: z.literal('done'), agents: z.number().int().nonnegative() }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

// ---------------------------------------------------------------------------
// Ask - the streamed, cited answer experience.
// ---------------------------------------------------------------------------

export const CitationSchema = z.object({
  /** 1-based citation number as it appears in the answer text, e.g. [1]. */
  index: z.number().int().positive(),
  resourceId: z.string().min(1),
  title: z.string().min(1),
  passage: z.string().optional(),
})

export const AskStageSchema = z.enum(['preprocessing', 'retrieval', 'generating', 'validating'])

export const AskEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stage'),
    stage: AskStageSchema,
    status: z.enum(['started', 'completed']),
  }),
  z.object({ type: z.literal('sources'), resources: ScoredResourceSchema.array() }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('citation'), citation: CitationSchema }),
  z.object({
    /** Platform learning id for this answer - target for feedback. */
    type: z.literal('learning'),
    id: z.string(),
  }),
  z.object({
    /** The query as the platform interpreted or rephrased it. */
    type: z.literal('interpreted'),
    query: z.string(),
  }),
  z.object({
    type: z.literal('quality'),
    /** REMi scores, 0 to 5. Null when a metric could not be computed. */
    answerRelevance: z.number().nullable(),
    groundedness: z.number().nullable(),
    contextRelevance: z.number().nullable(),
  }),
  z.object({
    type: z.literal('usage'),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    firstChunkSec: z.number().nonnegative().optional(),
    totalSec: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('done'),
    /** True when the corpus could not answer and guidance was shown instead. */
    refused: z.boolean().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Branding = z.infer<typeof BrandingSchema>
export type Topic = z.infer<typeof TopicSchema>
export type Question = z.infer<typeof QuestionSchema>
export type EntityType = z.infer<typeof EntityTypeSchema>
export type TenantSummary = z.infer<typeof TenantSummarySchema>
export type TenantConfig = z.infer<typeof TenantConfigSchema>
export type KnowledgeBoxStatus = z.infer<typeof KnowledgeBoxStatusSchema>
export type AdminTenantOverview = z.infer<typeof AdminTenantOverviewSchema>
export type KbCounters = z.infer<typeof KbCountersSchema>
export type RecentResource = z.infer<typeof RecentResourceSchema>
export type MigrationEvent = z.infer<typeof MigrationEventSchema>
export type AnalyseEvent = z.infer<typeof AnalyseEventSchema>
export type ResourceContent = z.infer<typeof ResourceContentSchema>
export type KbAgent = z.infer<typeof KbAgentSchema>
export type KgProposal = z.infer<typeof KgProposalSchema>
export type KgImplementEvent = z.infer<typeof KgImplementEventSchema>
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>
export type CatalogItem = z.infer<typeof CatalogItemSchema>
export type CatalogPage = z.infer<typeof CatalogPageSchema>
export type Labelset = z.infer<typeof LabelsetSchema>
export type FacetCounts = z.infer<typeof FacetCountsSchema>
export type GraphData = z.infer<typeof GraphDataSchema>
export type GenerateKind = z.infer<typeof GenerateKindSchema>
export type GenerateResult = {
  kind: GenerateKind
  object: unknown
  sources: ResourceSummary[]
}
export type ResourceType = z.infer<typeof ResourceTypeSchema>
export type ResourceSummary = z.infer<typeof ResourceSummarySchema>
export type ScoredResource = z.infer<typeof ScoredResourceSchema>
export type SearchResults = z.infer<typeof SearchResultsSchema>
export type Citation = z.infer<typeof CitationSchema>
export type AskStage = z.infer<typeof AskStageSchema>
export type AskEvent = z.infer<typeof AskEventSchema>
