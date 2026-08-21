import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
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

// ---------------------------------------------------------------------------
// Dynamic tenant store: the two seeds above plus knowledge box portals added
// in the app, persisted as JSON (TENANTS_PATH, default ./data/tenants.json).
// ---------------------------------------------------------------------------

/** Neutral dark palette for portals added in-app (until a theming pass). */
const DEFAULT_COLOURS = {
  primary: '#27364b',
  accent: '#5a8bd6',
  heroFrom: '#141d2b',
  heroTo: '#27364b',
}

export interface NewTenantInput {
  name: string
  organisation?: string
  tagline?: string
}

/** Config fields corpus analysis is allowed to rewrite. */
export interface TenantPatch {
  topics?: TenantConfig['topics']
  suggestedQuestions?: TenantConfig['suggestedQuestions']
  searchPlaceholder?: string
}

export class TenantStore {
  private custom: Record<string, TenantConfig> = {}
  /** Analysis-derived overrides, applicable to seeded portals too. */
  private overrides: Record<string, TenantPatch> = {}
  private disabled = new Set<string>()
  private readonly path: string

  constructor(env: Record<string, string | undefined> = process.env) {
    this.path = env.TENANTS_PATH ?? './data/tenants.json'
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, unknown>
      // v2 format: { custom, overrides, disabled }. v1 was a bare custom map.
      const customSource = (raw.custom ?? raw) as Record<string, unknown>
      for (const [slug, value] of Object.entries(customSource)) {
        const parsed = TenantConfigSchema.safeParse(value)
        if (parsed.success) this.custom[slug] = parsed.data
      }
      if (raw.overrides && typeof raw.overrides === 'object') {
        this.overrides = raw.overrides as Record<string, TenantPatch>
      }
      if (Array.isArray(raw.disabled)) {
        this.disabled = new Set(raw.disabled.filter((s): s is string => typeof s === 'string'))
      }
    } catch {
      this.custom = {}
    }
  }

  get(slug: string): TenantConfig | undefined {
    const base = tenantsBySlug[slug] ?? this.custom[slug]
    if (!base) return undefined
    const override = this.overrides[slug]
    return override ? { ...base, ...override } : base
  }

  isCustom(slug: string): boolean {
    return slug in this.custom && !(slug in tenantsBySlug)
  }

  isDisabled(slug: string): boolean {
    return this.disabled.has(slug)
  }

  setDisabled(slug: string, disabled: boolean): void {
    if (disabled) this.disabled.add(slug)
    else this.disabled.delete(slug)
    this.persist()
  }

  /** Apply analysis-derived config (topics, questions, placeholder). */
  patch(slug: string, patch: TenantPatch): void {
    this.overrides[slug] = { ...this.overrides[slug], ...patch }
    this.persist()
  }

  list(includeDisabled = false): TenantSummary[] {
    const all = [
      ...tenantSummaries(),
      ...Object.values(this.custom).map((tenant) => ({
        slug: tenant.slug,
        organisation: tenant.branding.organisation,
        productName: tenant.branding.productName,
        tagline: tenant.branding.tagline,
      })),
    ]
    return includeDisabled ? all : all.filter((t) => !this.disabled.has(t.slug))
  }

  add(input: NewTenantInput): TenantConfig {
    const base = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (!base) throw new Error('The portal name must contain letters or numbers')
    let slug = base
    for (let i = 2; this.get(slug); i++) slug = `${base}-${i}`
    const config = TenantConfigSchema.parse({
      slug,
      branding: {
        productName: input.name,
        organisation: input.organisation?.trim() || input.name,
        tagline: input.tagline?.trim() || 'Research, discovery and development',
        colours: DEFAULT_COLOURS,
      },
      searchPlaceholder: 'Search this knowledge box...',
      topics: [],
      suggestedQuestions: [],
      entityTypes: [],
      relationTypes: [],
    })
    this.custom[slug] = config
    this.persist()
    return config
  }

  remove(slug: string): boolean {
    if (!this.isCustom(slug)) return false
    delete this.custom[slug]
    delete this.overrides[slug]
    this.disabled.delete(slug)
    this.persist()
    return true
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(
      this.path,
      JSON.stringify(
        { custom: this.custom, overrides: this.overrides, disabled: [...this.disabled] },
        null,
        2,
      ),
    )
  }
}
