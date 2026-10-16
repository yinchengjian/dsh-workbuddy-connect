/**
 * WorkBuddy-backed web search for the DSH web capability seam (`ctx.web`).
 *
 * The seam exists so `web_search` never names a vendor: a deployment mounts one
 * or more search backends and pins one. This module is the backend that makes
 * WorkBuddy's *own* search available, so a machine whose only sign-in is the
 * WorkBuddy desktop app can search without a `DEEPSEEK_API_KEY` (or any other
 * second credential). That is the whole point: the plugin already reuses the
 * App's sign-in for chat, and the search service accepts that same token.
 *
 * Transport is `WorkBuddyUpstreamClient.search`; this module owns only the seam
 * contract — which product's account to search with, how a normalized
 * {@link WebSearchResult} is shaped, and how an upstream failure becomes a
 * machine-routable {@link WebError}.
 *
 * @module dsh-workbuddy-connect/search-provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult } from '@deepseek-ai/dsh-web'
import type { WorkBuddyCredentialStore } from './auth.ts'
import type { WorkBuddySearchResult, WorkBuddyUpstreamClient } from './upstream.ts'

/**
 * Stable provider id this backend registers under.
 *
 * Namespaced with `-search` because the suffix is what a pinned
 * `searchProvider` in a profile patch names, and the plugin already owns the
 * `workbuddy` / `workbuddy-ai` ids for its *model* routes: reusing one of those
 * would read as if the model provider were also the search provider.
 */
export const WORKBUDDY_SEARCH_PROVIDER = 'workbuddy-search'

/** One product's search backend: the credential store and transport it searches with. */
export interface WorkBuddySearchBackend {
  /** Model-route id this backend answers for (`workbuddy` / `workbuddy-ai`). */
  providerId: string
  /** Product heading for guidance copy, e.g. `WorkBuddy AI`. */
  displayName: string
  /** The desktop app a signed-out user must sign in to. */
  appName: string
  /** That product's credential store; `resolve()` reads the App's sign-in. */
  store: WorkBuddyCredentialStore
  /** The shared upstream client that reaches that product's search route. */
  client: WorkBuddyUpstreamClient
}

/** Wiring the provider needs from the plugin. */
export interface WorkBuddySearchProviderOptions {
  /** Every product variant, in preference order when nothing else selects one. */
  backends: readonly WorkBuddySearchBackend[]
  /**
   * The model route of the conversation that initiated this search, or
   * `undefined` outside an agent boundary.
   *
   * A conversation already using one product should search with that same
   * product's account: a user signed in to both apps has two independent
   * credits and two model groups, and letting the CN account answer for an
   * international conversation (or the reverse) would silently cross them. This
   * mirrors the DeepSeek provider, which reads the same route to decide between
   * its account and API-key credentials.
   */
  initiatingProvider: () => string | undefined
}

/**
 * The WorkBuddy search backend.
 *
 * One instance serves every variant and picks a product per search, so the seam
 * sees a single provider id to pin while both apps keep their own account.
 */
export class WorkBuddySearchProvider implements WebSearchProvider {
  readonly id = WORKBUDDY_SEARCH_PROVIDER

  constructor(private readonly options: WorkBuddySearchProviderOptions) {}

  /**
   * Whether this backend can be selected.
   *
   * Always true, and deliberately so: the plugin always mounts an account
   * resolver, which is exactly the condition `dsh-web` documents a provider's
   * cheap local check to establish. Whether an account is *actually* signed in
   * cannot be answered without reading the App's credential files, which is
   * asynchronous, and the seam's selection check is synchronous. So a
   * signed-out search fails inside {@link search} with a specific
   * `WEB_PROVIDER_CREDENTIAL_MISSING` message that names the app to sign in to,
   * rather than making the pinned provider disappear and have the seam report
   * the far less actionable `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`. The shipped
   * DeepSeek provider resolves this same tension the same way.
   */
  available(): boolean {
    return true
  }

  /**
   * Run one search through the selected product's account.
   *
   * Selects the product first (the conversation's own route, else the first
   * variant that answers), then makes exactly one upstream request: a variant
   * that has no credential is skipped, but one whose search *fails* is not
   * silently retried against the other account, because that would spend a
   * second user's quota to paper over the first one's error.
   *
   * @param request - the query plus the seam's source bound.
   * @param signal - caller cancellation, forwarded to the request.
   * @returns normalized, deduplicated sources; the seam owns `maxResults` truncation.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const failures: string[] = []
    for (const backend of this.orderedBackends()) {
      let credential
      try {
        // `resolve()`, not `current()`: it performs the locked single-flight
        // token renewal, so a search after an expired access token refreshes
        // instead of failing until something else happens to renew it.
        credential = await backend.store.resolve()
      } catch (error: unknown) {
        // Signed out, an unreadable credential file, or a sealed file whose
        // Electron helper could not be located. Each carries its own actionable
        // message, which is kept for the combined error below.
        failures.push(`${backend.displayName}: ${safeMessage(error)}`)
        continue
      }
      const outcome = await backend.client.search(credential, request.query, signal, request.maxResults)
      if (outcome.ok) return toWebResult(outcome.result)
      // A search the caller cancelled is not an upstream failure; report it with
      // the seam's cancellation code so the tool layer can tell the two apart.
      if (signal?.aborted === true) {
        throw new WebError('WorkBuddy web search aborted', 'WEB_ABORTED', { cause: signal.reason })
      }
      throw new WebError(
        `${backend.displayName} web search failed${outcome.status === 0 ? '' : ` (HTTP ${outcome.status})`}: ${outcome.message}`,
        'WEB_PROVIDER_ERROR',
      )
    }
    throw new WebError(noAccountMessage(failures), 'WEB_PROVIDER_CREDENTIAL_MISSING')
  }

  /**
   * Candidate products for one search: the conversation's own route first, then
   * the rest in declaration order.
   *
   * The route match is a preference, not a filter. A conversation on the
   * international group whose app is signed out should still be able to search
   * with a signed-in CN account rather than fail, and a search is attributed by
   * the account that actually answered it.
   */
  private orderedBackends(): readonly WorkBuddySearchBackend[] {
    const initiating = this.options.initiatingProvider()
    if (initiating === undefined) return this.options.backends
    const matched = this.options.backends.filter(backend => backend.providerId === initiating)
    if (matched.length === 0) return this.options.backends
    return [...matched, ...this.options.backends.filter(backend => backend.providerId !== initiating)]
  }
}

/**
 * Project the upstream's hit shape onto the seam's portable citation shape.
 *
 * `truncated` is always false: the request already asked for at most as many
 * hits as the caller wanted, and the seam re-caps `sources` itself, so claiming
 * truncation here would double-report it.
 *
 * No `publishedAt` is set: the search service returns no page-age field, and
 * inventing one would make the seam lie about recency.
 */
export function toWebResult(result: WorkBuddySearchResult): WebSearchResult {
  return {
    sources: result.results.map(hit => ({
      url: hit.url,
      ...hit.title === undefined ? {} : { title: hit.title },
      ...hit.snippet === undefined ? {} : { snippet: hit.snippet },
    })),
    truncated: false,
  }
}

/**
 * The error a search raises when no product had a usable credential.
 *
 * Names what was tried and what to do: sign in, or point the deployment at a
 * different backend. The endpoint guidance the DeepSeek provider appends is
 * deliberately absent — there is no search endpoint to configure here, because
 * the route is derived from the signed-in product.
 */
function noAccountMessage(failures: readonly string[]): string {
  return [
    'WorkBuddy web search has no usable sign-in.',
    ...failures.length === 0 ? [] : [`Tried: ${failures.join('; ')}.`],
    'Sign in once in the WorkBuddy (or WorkBuddy AI) desktop app so this plugin can search with that account,',
    'or guide the user to Settings > Plugins > Plugin configuration > Web search to select and configure another web search provider.',
  ].join(' ')
}

/** Bound an unexpected message so a credential path cannot flood a tool result. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/gu, ' ').slice(0, 300)
}
