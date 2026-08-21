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
  z.object({ type: z.literal('done') }),
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
export type ResourceType = z.infer<typeof ResourceTypeSchema>
export type ResourceSummary = z.infer<typeof ResourceSummarySchema>
export type ScoredResource = z.infer<typeof ScoredResourceSchema>
export type SearchResults = z.infer<typeof SearchResultsSchema>
export type Citation = z.infer<typeof CitationSchema>
export type AskStage = z.infer<typeof AskStageSchema>
export type AskEvent = z.infer<typeof AskEventSchema>
