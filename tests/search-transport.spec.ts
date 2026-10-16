import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkBuddyCredential } from '../src/auth.ts'
import { WorkBuddyUpstreamClient, parseSearchResponse } from '../src/upstream.ts'

/**
 * Offline unit tests for the agent-tool search transport.
 *
 * `fetch` is mocked so the request shape (route, method, auth header, body) and
 * the response handling are pinned without a real account or network. The route
 * itself was verified live against both region bases (`/agenttool/v1/search`
 * answering 200 with a bare bearer token, 401 without one); these specs are
 * what keep the plugin's side of that contract from drifting.
 */

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAtMs: 0,
  domain: 'www.codebuddy.cn',
  uid: 'uid-1',
  source: 'desktop',
}

/** A JSON-answering Response-like object; `search` reads `.json()`. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

/** Capture the URL plus init of the single fetch a call makes. */
function captureFetch(response: Response): { url: string, init: RequestInit | undefined } {
  const captured: { url: string, init: RequestInit | undefined } = { url: '', init: undefined }
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    captured.url = url
    captured.init = init
    return Promise.resolve(response)
  })
  return captured
}

/** The JSON body a captured request sent. */
function sentBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkBuddyUpstreamClient.search', () => {
  it('POSTs the agent-tool search route on the credential region base', async () => {
    const captured = captureFetch(jsonResponse({ provider: '0', results: [] }))
    await new WorkBuddyUpstreamClient().search(CREDENTIAL, 'deepseek harness')
    expect(captured.url).toBe('https://copilot.tencent.com/agenttool/v1/search')
    expect(captured.init?.method).toBe('POST')
  })

  it('routes the international credential to its own base', async () => {
    const captured = captureFetch(jsonResponse({ results: [] }))
    await new WorkBuddyUpstreamClient().search({ ...CREDENTIAL, domain: 'www.workbuddy.ai' }, 'q')
    expect(captured.url).toBe('https://www.workbuddy.ai/agenttool/v1/search')
  })

  it('sends the bearer token and never the refresh token', async () => {
    const captured = captureFetch(jsonResponse({ results: [] }))
    await new WorkBuddyUpstreamClient().search(CREDENTIAL, 'q')
    const headers = captured.init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer at')
    // 安全红线：只有 refresh 路由可以携带 refresh token。
    expect(JSON.stringify(headers)).not.toContain('rt')
  })

  it('sends the text2text query body', async () => {
    const captured = captureFetch(jsonResponse({ results: [] }))
    await new WorkBuddyUpstreamClient().search(CREDENTIAL, 'deepseek harness')
    expect(sentBody(captured.init)).toEqual({ query: 'deepseek harness', type: 'text2text', max_results: 20 })
  })

  it('asks for no more hits than the caller will show', async () => {
    const captured = captureFetch(jsonResponse({ results: [] }))
    await new WorkBuddyUpstreamClient().search(CREDENTIAL, 'q', undefined, 3)
    expect(sentBody(captured.init)['max_results']).toBe(3)
  })

  it('never asks for more than the transport ceiling', async () => {
    const captured = captureFetch(jsonResponse({ results: [] }))
    await new WorkBuddyUpstreamClient().search(CREDENTIAL, 'q', undefined, 500)
    expect(sentBody(captured.init)['max_results']).toBe(20)
  })

  it('maps a non-ok response to a classified failure', async () => {
    captureFetch(jsonResponse('nope', false, 401))
    const outcome = await new WorkBuddyUpstreamClient().search(CREDENTIAL, 'q')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.status).toBe(401)
    expect(outcome.kind).toBe('session_dead')
  })

  it('treats an in-body error code as a failure even on HTTP 200', async () => {
    // Measured: a rejected `freshness` answers 400/`{code,msg}`; a 200 carrying
    // a non-zero code must not be mistaken for a result-less success.
    captureFetch(jsonResponse({ code: 15003, msg: 'invalid freshness "bogus"' }))
    const outcome = await new WorkBuddyUpstreamClient().search(CREDENTIAL, 'q')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.message).toContain('invalid freshness')
  })

  it('fails loudly when the body carries no results array', async () => {
    captureFetch(jsonResponse({ provider: '0' }))
    const outcome = await new WorkBuddyUpstreamClient().search(CREDENTIAL, 'q')
    expect(outcome.ok).toBe(false)
  })

  it('reports a transport throw instead of rejecting', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    const outcome = await new WorkBuddyUpstreamClient().search(CREDENTIAL, 'q')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.message).toContain('offline')
  })
})

describe('parseSearchResponse', () => {
  it('keeps title, url, and snippet', () => {
    expect(parseSearchResponse({
      provider: '0',
      results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }],
    })).toEqual({
      provider: '0',
      results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }],
    })
  })

  it('drops a result with no url, because the seam requires one', () => {
    const parsed = parseSearchResponse({ results: [{ title: 'no url' }, { url: 'https://ok.example' }] })
    expect(parsed?.results).toEqual([{ url: 'https://ok.example' }])
  })

  it('omits an empty title rather than inventing one', () => {
    expect(parseSearchResponse({ results: [{ title: '', url: 'https://example.com' }] })?.results)
      .toEqual([{ url: 'https://example.com' }])
  })

  it('omits an empty snippet', () => {
    expect(parseSearchResponse({ results: [{ url: 'https://example.com', snippet: '' }] })?.results)
      .toEqual([{ url: 'https://example.com' }])
  })

  it('rejects a body that is not a search answer', () => {
    expect(parseSearchResponse(null)).toBeUndefined()
    expect(parseSearchResponse({ nope: true })).toBeUndefined()
  })

  it('keeps an empty result list distinct from a malformed body', () => {
    expect(parseSearchResponse({ results: [] })).toEqual({ results: [] })
  })
})
