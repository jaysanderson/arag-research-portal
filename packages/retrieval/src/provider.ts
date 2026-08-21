import type {
  AskEvent,
  CatalogPage,
  FacetCounts,
  Labelset,
  Question,
  ResourceSummary,
  RetrievalMode,
  SearchResults,
  TenantConfig,
} from '@research-portal/core'

export interface SearchOptions {
  mode?: RetrievalMode
  /** Topic ids (labels in the 'topic' labelset) to filter by. */
  topicIds?: string[]
  pageSize?: number
}

export interface AskOptions {
  /** Prior turns, oldest first, for multi-turn conversations. */
  context?: { author: 'USER' | 'AGENT'; text: string }[]
  /** Scope the answer to a single resource (per-document chat). */
  resourceId?: string
  topicIds?: string[]
}

export interface CatalogOptions {
  page?: number
  pageSize?: number
  query?: string
  topicIds?: string[]
  sortField?: 'created' | 'modified' | 'title'
  sortOrder?: 'asc' | 'desc'
}

/**
 * The only doorway between the portal and any AI/retrieval backend.
 *
 * Implementations map a vendor API (Progress Agentic RAG) into portal domain
 * types. Nothing vendor-shaped crosses this boundary, so swapping backends is
 * configuration, not a rewrite. Server-side only - credentials never reach
 * the client.
 */
export interface RetrievalProvider {
  listResources(tenant: TenantConfig): Promise<ResourceSummary[]>
  resource(tenant: TenantConfig, id: string): Promise<ResourceSummary | null>
  search(tenant: TenantConfig, query: string, opts?: SearchOptions): Promise<SearchResults>
  suggest(tenant: TenantConfig): Promise<Question[]>
  ask(tenant: TenantConfig, query: string, opts?: AskOptions): AsyncIterable<AskEvent>
  catalog(tenant: TenantConfig, opts?: CatalogOptions): Promise<CatalogPage>
  facets(tenant: TenantConfig, labelsets: string[]): Promise<FacetCounts>
  labelsets(tenant: TenantConfig): Promise<Labelset[]>
}
