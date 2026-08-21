import { type TenantConfig, TenantConfigSchema, type TenantSummary } from '@research-portal/core'

// ---------------------------------------------------------------------------
// Seed tenant configs. These move to SQLite in the provisioning increment -
// for now they are the single source of truth for tenant-driven theming and
// copy, validated at module load so a bad seed fails fast on boot.
// ---------------------------------------------------------------------------

const grdc: TenantConfig = TenantConfigSchema.parse({
  slug: 'grdc',
  branding: {
    productName: 'GRDC Research Portal',
    organisation: 'Grains Research and Development Corporation',
    tagline: 'Grains research, discovery and development',
    colours: {
      primary: '#1a5632',
      accent: '#d4a72c',
      heroFrom: '#0d2b18',
      heroTo: '#1a5632',
    },
  },
  searchPlaceholder: 'Search crop protection, soils, farm business, climate...',
  topics: [
    { id: 'crop-protection', label: 'Crop protection' },
    { id: 'soils-nutrition', label: 'Soils and nutrition' },
    { id: 'farm-business', label: 'Farm business' },
    { id: 'climate-environment', label: 'Climate and environment' },
    { id: 'harvest-storage', label: 'Harvest and storage' },
  ],
  suggestedQuestions: [
    {
      id: 'grdc-q1',
      text: 'What are the best rotation strategies for managing herbicide-resistant ryegrass?',
    },
    { id: 'grdc-q2', text: 'How does nitrogen timing affect grain protein in dryland wheat?' },
    { id: 'grdc-q3', text: 'What is the latest guidance on managing net blotch in barley?' },
    {
      id: 'grdc-q4',
      text: 'Which farm business tools help benchmark input costs against regional yields?',
    },
    {
      id: 'grdc-q5',
      text: 'What storage conditions reduce the risk of grain quality loss after harvest?',
    },
    {
      id: 'grdc-q6',
      text: 'How is climate variability changing sowing windows across the southern region?',
    },
  ],
  entityTypes: [
    { id: 'crop', label: 'Crop', colour: '#7cb342' },
    { id: 'pest', label: 'Pest or disease', colour: '#e53935' },
    { id: 'researcher', label: 'Researcher', colour: '#5e97f6' },
    { id: 'project', label: 'GRDC project', colour: '#d4a72c' },
    { id: 'region', label: 'Growing region', colour: '#26a69a' },
  ],
  relationTypes: ['studies', 'affects', 'conducted-in', 'funded-by', 'collaborates-with'],
})

const frdc: TenantConfig = TenantConfigSchema.parse({
  slug: 'frdc',
  branding: {
    productName: 'FRDC Knowledge Hub',
    organisation: 'Fisheries Research and Development Corporation',
    tagline: 'Fisheries and aquaculture research and development',
    colours: {
      primary: '#123a5c',
      accent: '#2c9c91',
      heroFrom: '#0b2438',
      heroTo: '#14503f',
    },
  },
  searchPlaceholder: 'Search fisheries, aquaculture, stock assessment, marine ecology...',
  topics: [
    { id: 'stock-assessment', label: 'Fisheries stock assessment' },
    { id: 'aquaculture-biosecurity', label: 'Aquaculture biosecurity' },
    { id: 'post-harvest', label: 'Post-harvest innovation' },
    { id: 'marine-sustainability', label: 'Marine sustainability' },
    { id: 'fisheries-policy', label: 'Fisheries management policy' },
  ],
  suggestedQuestions: [
    {
      id: 'frdc-q1',
      text: 'What stock assessment methods are recommended for data-limited fisheries?',
    },
    { id: 'frdc-q2', text: 'How is white spot disease being managed in prawn aquaculture?' },
    {
      id: 'frdc-q3',
      text: 'What post-harvest handling practices best preserve rock lobster quality?',
    },
    {
      id: 'frdc-q4',
      text: 'How are marine heatwaves affecting abalone populations along the southern coast?',
    },
    {
      id: 'frdc-q5',
      text: 'What biosecurity controls reduce pathogen spread between aquaculture leases?',
    },
    {
      id: 'frdc-q6',
      text: 'What does the latest research say about bycatch reduction in trawl fisheries?',
    },
  ],
  entityTypes: [
    { id: 'species', label: 'Species', colour: '#7cb342' },
    { id: 'researcher', label: 'Researcher', colour: '#5e97f6' },
    { id: 'project', label: 'FRDC project', colour: '#2c9c91' },
    { id: 'pathogen', label: 'Pathogen', colour: '#e53935' },
    { id: 'location', label: 'Location', colour: '#f6bf26' },
  ],
  relationTypes: ['studies', 'infects', 'located-in', 'funded-by', 'assesses'],
})

const tenantsBySlug: Record<string, TenantConfig> = {
  grdc,
  frdc,
}

export function tenantConfig(slug: string): TenantConfig | undefined {
  return tenantsBySlug[slug]
}

export function tenantSummaries(): TenantSummary[] {
  return Object.values(tenantsBySlug).map((tenant) => ({
    slug: tenant.slug,
    organisation: tenant.branding.organisation,
    productName: tenant.branding.productName,
    tagline: tenant.branding.tagline,
  }))
}
