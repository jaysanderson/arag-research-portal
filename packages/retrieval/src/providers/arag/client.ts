/**
 * Thin REST client for the Progress Agentic RAG (Nuclia) regional API.
 * Knowledge-box data operations authenticate with a per-KB service-account
 * token; account-level management (used by provisioning) uses the account key.
 */

export interface KbBinding {
  kbId: string
  token: string
}

export class AragApiError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    detail: string,
  ) {
    super(`Agentic RAG API ${status} for ${url}: ${detail.slice(0, 300)}`)
    this.name = 'AragApiError'
  }
}

export const regionalBase = (zone: string) => `https://${zone}.rag.progress.cloud/api/v1`

export class KbClient {
  constructor(
    private readonly zone: string,
    private readonly binding: KbBinding,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private url(path: string) {
    return `${regionalBase(this.zone)}/kb/${this.binding.kbId}${path}`
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-nuclia-serviceaccount': `Bearer ${this.binding.token}`,
      ...extra,
    }
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const url = this.url(path)
    const res = await this.fetchImpl(url, { headers: this.headers() })
    if (!res.ok) throw new AragApiError(res.status, url, await res.text())
    return (await res.json()) as T
  }

  async postJson<T = unknown>(
    path: string,
    body: unknown,
    extra?: Record<string, string>,
  ): Promise<T> {
    const url = this.url(path)
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.headers(extra),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new AragApiError(res.status, url, await res.text())
    return (await res.json()) as T
  }

  /** POST returning the raw streaming response (NDJSON body). */
  async postStream(path: string, body: unknown): Promise<Response> {
    const url = this.url(path)
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new AragApiError(res.status, url, await res.text())
    return res
  }
}

/** Iterate the JSON objects of an NDJSON response body, tolerating partial chunks. */
export async function* ndjson(res: Response): AsyncGenerator<unknown> {
  const reader = res.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        try {
          yield JSON.parse(line)
        } catch {
          // Partial or non-JSON line - skip rather than kill the stream.
        }
      }
      newline = buffer.indexOf('\n')
    }
  }
  const tail = buffer.trim()
  if (tail) {
    try {
      yield JSON.parse(tail)
    } catch {
      // ignore trailing partial line
    }
  }
}
