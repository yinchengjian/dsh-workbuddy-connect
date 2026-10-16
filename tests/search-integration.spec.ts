import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as WorkBuddy from '../src/index.ts'

/**
 * Integration tests for the WorkBuddy search backend inside a real host tree.
 *
 * These mount the actual plugin next to the actual `ctx.web` seam, so what is
 * proven is the wiring — that the plugin registers a provider the seam can
 * select, that it does so without disturbing the models it already serves, and
 * that it disposes cleanly (a reload that left the id registered would make the
 * next boot fail with WEB_DUPLICATE_PROVIDER).
 *
 * The network is never touched: the credential files are absent, so every
 * search stops at "no sign-in" before any request is made.
 */

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true })
        break
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= 4 || (code !== 'ENOTEMPTY' && code !== 'ENOENT')) throw error
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
  }
  root = undefined
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

/** Boot one host tree with the seam and the plugin, both pointed at a temp home. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WebRuntime, { searchProvider: WorkBuddy.WORKBUDDY_SEARCH_PROVIDER })
  await ctx.plugin(WorkBuddy, {})
  return ctx
}

describe('WorkBuddy search backend registration', () => {
  it('registers a provider the pinned seam resolves', async () => {
    root = await mkdtemp(join(tmpdir(), 'workbuddy-search-register-'))
    vi.stubEnv('DSH_HOME', root)
    // Both variants signed out: registration must not depend on a sign-in.
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE_AI', join(root, 'absent-ai.info'))
    context = await boot()
    // The seam reaching the provider at all is the wiring under test: an
    // unregistered or differently-named id would fail here with
    // WEB_PROVIDER_CONFIGURED_MISSING.
    await expect(context.web.search({ query: 'q', maxResults: 1 }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
  })

  it('names the app to sign in to when no account is signed in', async () => {
    root = await mkdtemp(join(tmpdir(), 'workbuddy-search-signedout-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE_AI', join(root, 'absent-ai.info'))
    context = await boot()
    const failure = await context.web.search({ query: 'q' }).catch((error: unknown) => error)
    expect(String((failure as Error).message)).toMatch(/sign in once in the WorkBuddy/iu)
  })

  it('leaves the model provider serving models while search is registered', async () => {
    root = await mkdtemp(join(tmpdir(), 'workbuddy-search-models-'))
    const cnFile = join(root, 'cn.info')
    await writeFile(cnFile, JSON.stringify({
      auth: { accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, domain: 'copilot.tencent.com' },
      account: { uid: 'uid-1', enterpriseId: '' },
    }))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', cnFile)
    vi.stubEnv('WORKBUDDY_AUTH_FILE_AI', join(root, 'absent-ai.info'))
    // Stubbed so signing in cannot reach the catalog endpoint: these specs must
    // stay offline. The fallback roster is what the picker then serves.
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    context = await boot()
    await vi.waitFor(async () => {
      expect((await context!.llm.listModels('workbuddy')).length).toBeGreaterThan(0)
    })
  })

  it('releases its registration when the plugin disposes, so a reload cannot collide', async () => {
    root = await mkdtemp(join(tmpdir(), 'workbuddy-search-reload-'))
    vi.stubEnv('DSH_HOME', root)
    vi.stubEnv('WORKBUDDY_AUTH_FILE', join(root, 'absent-cn.info'))
    vi.stubEnv('WORKBUDDY_AUTH_FILE_AI', join(root, 'absent-ai.info'))

    const ctx = new Context()
    context = ctx
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(WebRuntime, { searchProvider: WorkBuddy.WORKBUDDY_SEARCH_PROVIDER })
    const pluginFiber = await ctx.plugin(WorkBuddy, {})

    // Probe the registry through the same seam by attempting a duplicate
    // registration of that exact id: `free` means nothing owns it.
    const claim = (): string => {
      try {
        ctx.web.registerSearchProvider({
          id: WorkBuddy.WORKBUDDY_SEARCH_PROVIDER,
          available: () => true,
          search: () => Promise.resolve({ sources: [], truncated: false }),
        })
        return 'free'
      } catch (error: unknown) {
        return (error as { code?: string }).code ?? String(error)
      }
    }

    // Registration must be owned by the plugin's own fiber. A reload disposes
    // that fiber and mounts again; a leaked id would make the next mount throw
    // WEB_DUPLICATE_PROVIDER inside its inject callback.
    expect(claim()).toBe('WEB_DUPLICATE_PROVIDER')
    await pluginFiber.dispose()
    expect(claim()).toBe('free')
  })
})
