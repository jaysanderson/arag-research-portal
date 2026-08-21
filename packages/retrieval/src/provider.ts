import type {
  AskEvent,
  Question,
  ResourceSummary,
  SearchResults,
  TenantConfig,
} from '@research-portal/core'

/**
 * The only doorway between the portal and any AI/retrieval backend.
 *
 * Implementations map a vendor API (Progress Agentic RAG, or fixtures for the
 * mock) into portal domain types. Nothing vendor-shaped crosses this boundary,
 * so swapping backends is configuration, not a rewrite. Server-side only -
 * credentials never reach the client.
 *
 * Management operations (provisioning a knowledge box, labels, graph config,
 * agents) are added in the provisioning increment.
 */
export interface RetrievalProvider {
  listResources(tenant: TenantConfig): Promise<ResourceSummary[]>
  resource(tenant: TenantConfig, id: string): Promise<ResourceSummary | null>
  search(tenant: TenantConfig, query: string): Promise<SearchResults>
  suggest(tenant: TenantConfig): Promise<Question[]>
  ask(tenant: TenantConfig, query: string): AsyncIterable<AskEvent>
}
