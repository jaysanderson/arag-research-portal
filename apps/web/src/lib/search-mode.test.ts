import { describe, it } from '@std/testing/bdd'
import { expect } from '@std/expect'
import { answerModeParam, readAnswerMode } from './search-mode.ts'

describe('readAnswerMode', () => {
  it('defaults to Find (no answer) when the param is absent', () => {
    expect(readAnswerMode(new URLSearchParams(''))).toBe(false)
    expect(readAnswerMode(new URLSearchParams('q=carp'))).toBe(false)
  })

  it('reads Ask mode only from the exact opt-in value', () => {
    expect(readAnswerMode(new URLSearchParams('answer=1'))).toBe(true)
    expect(readAnswerMode(new URLSearchParams('q=carp&answer=1'))).toBe(true)
  })

  it('treats any other value as Find, so a stray param never spends an LLM call', () => {
    expect(readAnswerMode(new URLSearchParams('answer=0'))).toBe(false)
    expect(readAnswerMode(new URLSearchParams('answer=true'))).toBe(false)
    expect(readAnswerMode(new URLSearchParams('answer='))).toBe(false)
  })
})

describe('answerModeParam', () => {
  it('turns Ask on with the opt-in value', () => {
    expect(answerModeParam(true)).toBe('1')
  })

  it('clears the param for Find so the URL stays clean', () => {
    expect(answerModeParam(false)).toBe(null)
  })

  it('round-trips through a URLSearchParams patch', () => {
    const params = new URLSearchParams('q=carp')
    const value = answerModeParam(true)
    if (value === null) params.delete('answer')
    else params.set('answer', value)
    expect(readAnswerMode(params)).toBe(true)

    const cleared = answerModeParam(false)
    if (cleared === null) params.delete('answer')
    else params.set('answer', cleared)
    expect(readAnswerMode(params)).toBe(false)
  })
})
