import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import type { KnowledgeBoxStatus } from '@research-portal/core'
import { envBindings, type KbBinding } from '@research-portal/retrieval'

interface StoredBinding extends KbBinding {
  connectedAt: string
}

/**
 * Resolves each tenant's knowledge box binding. Two tiers:
 * - env bindings (ARAG_KB_<SLUG>[_TOKEN]) are the seeded DEMO boxes
 * - bindings connected by an administrator in the app override them, and are
 *   persisted to a JSON file (BINDINGS_PATH, default ./data/bindings.json)
 * Tokens never leave the server; status reporting carries a truncated KB id only.
 */
export class BindingStore {
  private readonly demo: Record<string, KbBinding>
  private connected: Record<string, StoredBinding> = {}
  private readonly path: string

  constructor(env: Record<string, string | undefined> = process.env) {
    this.demo = envBindings(env)
    this.path = env.BINDINGS_PATH ?? './data/bindings.json'
    try {
      this.connected = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      this.connected = {}
    }
  }

  get(slug: string): KbBinding | undefined {
    return this.connected[slug] ?? this.demo[slug]
  }

  isDemo(slug: string): boolean {
    return !this.connected[slug] && Boolean(this.demo[slug])
  }

  set(slug: string, binding: KbBinding): void {
    this.connected[slug] = { ...binding, connectedAt: new Date().toISOString() }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(this.connected, null, 2))
  }

  status(slug: string): KnowledgeBoxStatus {
    const connected = this.connected[slug]
    if (connected) {
      return { slug, status: 'connected', kbId: truncate(connected.kbId) }
    }
    const demo = this.demo[slug]
    if (demo) return { slug, status: 'demo', kbId: truncate(demo.kbId) }
    return { slug, status: 'none' }
  }
}

const truncate = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id)
