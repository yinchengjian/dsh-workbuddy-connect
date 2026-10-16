import { describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredentialStore } from '../src/auth.ts'
import type { WorkBuddySearchOutcome, WorkBuddyUpstreamClient } from '../src/upstream.ts'
import { WORKBUDDY_SEARCH_PROVIDER, WorkBuddySearchProvider, toWebResult, type WorkBuddySearchBackend } from '../src/search-provider.ts'

/**
 * Unit tests for the seam-facing search provider.
 *
 * The credential store and upstream client are doubled, so these specs pin the
 * provider's own decisions — which product answers, how hits become seam
 * sources, and how a failure is reported — with no filesystem or network.
 */

const OK: WorkBuddySearchOutcome = {
  ok: true,
  result: { provider: '0', results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }] },
}

/** Marker for "this product has no usable credential". */
const SIGNED_OUT = Symbol('signed-out')

/** A backend whose account resolves and whose search answers as instructed. */
function backend(
  providerId: string,
  outcome: WorkBuddySearchOutcome = OK,
  /**
   * The credential to resolve, or `SIGNED_OUT` for an account-less product.
   * A sentinel rather than `undefined`, because a defaulted `undefined`
   * parameter would silently mean "use the signed-in default" and make the
   * signed-out specs assert the opposite of what they claim.
   */
  credential: unknown = { accessToken: 'at' },
): { backend: WorkBuddySearchBackend, search: ReturnType<typeof vi.fn>, resolve: ReturnType<typeof vi.fn> } {
  const search = vi.fn(() => Promise.resolve(outcome))
  const resolve = vi.fn(() => credential === SIGNED_OUT
    ? Promise.reject(new Error('signed out'))
    : Promise.resolve(credential))
  return {
    backend: {
      providerId,
      displayName: providerId === 'workbuddy' ? 'WorkBuddy' : 'WorkBuddy AI',
      appName: providerId === 'workbuddy' ? 'WorkBuddy' : 'WorkBuddy AI',
      store: { resolve } as unknown as WorkBuddyCredentialStore,
      client: { search } as unknown as WorkBuddyUpstreamClient,
    },
    search,
    resolve,
  }
}

describe('WorkBuddySearchProvider', () => {
  it('registers under a search-scoped id, distinct from the model routes', () => {
    // The id is what a profile patch pins, so reusing a model-route id would
    // read as if the model provider were also the search provider.
    expect(WORKBUDDY_SEARCH_PROVIDER).toBe('workbuddy-search')
    expect(new WorkBuddySearchProvider({ backends: [], initiatingProvider: () => undefined }).id)
      .toBe(WORKBUDDY_SEARCH_PROVIDER)
  })

  it('reports available without touching the network or the credential files', () => {
    // Selection is a synchronous local check; an account read is async, so
    // availability cannot depend on it.
    const { backend: cn, resolve } = backend('workbuddy')
    expect(new WorkBuddySearchProvider({ backends: [cn], initiatingProvider: () => undefined }).available()).toBe(true)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('searches with the conversation\'s own product when that variant is signed in', async () => {
    const cn = backend('workbuddy')
    const ai = backend('workbuddy-ai')
    const provider = new WorkBuddySearchProvider({
      backends: [cn.backend, ai.backend],
      initiatingProvider: () => 'workbuddy-ai',
    })
    await provider.search({ query: 'q' })
    expect(ai.search).toHaveBeenCalledTimes(1)
    expect(cn.search).not.toHaveBeenCalled()
  })

  it('falls back to another signed-in product rather than failing', async () => {
    // A conversation on the international group whose app is signed out should
    // still search with a signed-in CN account.
    const cn = backend('workbuddy')
    const ai = backend('workbuddy-ai', OK, SIGNED_OUT)
    const provider = new WorkBuddySearchProvider({
      backends: [cn.backend, ai.backend],
      initiatingProvider: () => 'workbuddy-ai',
    })
    const result = await provider.search({ query: 'q' })
    expect(result.sources).toHaveLength(1)
    expect(cn.search).toHaveBeenCalledTimes(1)
  })

  it('prefers the initiating product even when it is declared later', async () => {
    const cn = backend('workbuddy')
    const ai = backend('workbuddy-ai')
    const provider = new WorkBuddySearchProvider({
      backends: [cn.backend, ai.backend],
      initiatingProvider: () => 'workbuddy-ai',
    })
    await provider.search({ query: 'q' })
    expect(ai.search).toHaveBeenCalled()
    expect(cn.search).not.toHaveBeenCalled()
  })

  it('uses the first declared product when no conversation route is readable', async () => {
    const cn = backend('workbuddy')
    const ai = backend('workbuddy-ai')
    const provider = new WorkBuddySearchProvider({
      backends: [cn.backend, ai.backend],
      initiatingProvider: () => undefined,
    })
    await provider.search({ query: 'q' })
    expect(cn.search).toHaveBeenCalledTimes(1)
  })

  it('ignores an initiating route that is not one of its own products', async () => {
    const cn = backend('workbuddy')
    const provider = new WorkBuddySearchProvider({
      backends: [cn.backend],
      initiatingProvider: () => 'deepseek-account',
    })
    await provider.search({ query: 'q' })
    expect(cn.search).toHaveBeenCalledTimes(1)
  })

  it('passes the seam\'s maxResults through as the request bound', async () => {
    const cn = backend('workbuddy')
    const provider = new WorkBuddySearchProvider({ backends: [cn.backend], initiatingProvider: () => undefined })
    await provider.search({ query: 'q', maxResults: 4 })
    expect(cn.search).toHaveBeenCalledWith(expect.anything(), 'q', undefined, 4)
  })

  it('reports a signed-out machine as a missing credential and names what to do', async () => {
    const cn = backend('workbuddy', OK, SIGNED_OUT)
    const provider = new WorkBuddySearchProvider({ backends: [cn.backend], initiatingProvider: () => undefined })
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
    // The message must be actionable, not merely accurate.
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/sign in once in the WorkBuddy/iu)
  })

  it('names every product it tried when none had an account', async () => {
    const cn = backend('workbuddy', OK, SIGNED_OUT)
    const ai = backend('workbuddy-ai', OK, SIGNED_OUT)
    const provider = new WorkBuddySearchProvider({ backends: [cn.backend, ai.backend], initiatingProvider: () => undefined })
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/WorkBuddy AI/iu)
  })

  it('reports an upstream failure as a provider error naming the product', async () => {
    const cn = backend('workbuddy', { ok: false, status: 500, kind: 'server', message: 'boom' })
    const provider = new WorkBuddySearchProvider({ backends: [cn.backend], initiatingProvider: () => undefined })
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/WorkBuddy web search failed \(HTTP 500\)/u)
  })

  it('does not retry a failed search against the other account', async () => {
    // Retrying would spend a second user's quota to paper over the first error.
    const cn = backend('workbuddy', { ok: false, status: 500, kind: 'server', message: 'boom' })
    const ai = backend('workbuddy-ai')
    const provider = new WorkBuddySearchProvider({ backends: [cn.backend, ai.backend], initiatingProvider: () => undefined })
    await expect(provider.search({ query: 'q' })).rejects.toThrow()
    expect(ai.search).not.toHaveBeenCalled()
  })

  it('reports caller cancellation with the seam\'s abort code', async () => {
    const controller = new AbortController()
    controller.abort()
    const cn = backend('workbuddy', { ok: false, status: 0, kind: 'server', message: 'transport error: aborted' })
    const provider = new WorkBuddySearchProvider({ backends: [cn.backend], initiatingProvider: () => undefined })
    await expect(provider.search({ query: 'q' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })
})

describe('toWebResult', () => {
  it('maps hits to seam sources', () => {
    expect(toWebResult({ provider: '0', results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }] }))
      .toEqual({ sources: [{ url: 'https://example.com', title: 'T', snippet: 'S' }], truncated: false })
  })

  it('omits absent optional fields instead of filling placeholders', () => {
    expect(toWebResult({ results: [{ url: 'https://example.com' }] }))
      .toEqual({ sources: [{ url: 'https://example.com' }], truncated: false })
  })

  it('never claims truncation, which the seam owns', () => {
    // The request already bounded the hits, and the seam re-caps sources, so
    // reporting truncation here would double-report it.
    const many = Array.from({ length: 20 }, (_, index) => ({ url: `https://example.com/${index}` }))
    expect(toWebResult({ results: many }).truncated).toBe(false)
  })

  it('survives an empty result list', () => {
    expect(toWebResult({ results: [] })).toEqual({ sources: [], truncated: false })
  })
})
