/** Shared styling and small types used across the admin page's subcomponents. */

export const inputClass =
  'w-full rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-neutral-900'

export type Message = { tone: 'ok' | 'error'; text: string }

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}
