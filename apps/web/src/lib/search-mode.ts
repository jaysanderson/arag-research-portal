/**
 * Search page intent: FIND returns results only (no LLM call, fast and cheap),
 * ASK returns results plus a streamed, cited AI answer. The choice is persisted
 * in the URL as `answer=1` so a Find search and an Ask search are each
 * shareable and reload to the same state. Find is the default - a plain search
 * never spends an LLM call and never makes the user wait.
 */

/** True when the URL asks for an AI answer (Ask mode); Find is the default. */
export function readAnswerMode(params: URLSearchParams): boolean {
  return params.get('answer') === '1'
}

/**
 * The `answer` URL param value for a mode, shaped for the page's param-patching
 * helper: `'1'` turns Ask on, `null` clears it back to the Find default so the
 * URL stays clean when no answer is wanted.
 */
export function answerModeParam(on: boolean): string | null {
  return on ? '1' : null
}
