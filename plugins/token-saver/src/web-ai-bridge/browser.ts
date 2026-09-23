/**
 * Browser lifecycle for the web-ai-bridge. Owns the Playwright browser/context
 * and per-provider pages, lazily started on first ask and torn down on unload.
 *
 * @module @dsh-plugins/token-saver/web-ai-bridge/browser
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { LocatorLike, PageLike } from './page.ts'
import type { ProviderConfig } from './driver.ts'

/** Browser configuration for the plugin. */
export interface BrowserConfig {
  mode: 'launch' | 'cdp'
  channel: 'msedge' | 'chrome'
  userDataDir?: string
  headless: boolean
  cdpUrl?: string
  args: string[]
}

/** Owns the Playwright browser/context and provider pages. */
export class BrowserManager {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private pages = new Map<string, PageLike>()
  private closing = false

  constructor(private readonly config: BrowserConfig) {}

  /** Whether the browser has been started. */
  get started(): boolean {
    return this.context !== undefined
  }

  /**
   * Lazily start the browser (or reuse the CDP connection). In launch mode the
   * context uses a persistent user-data dir so login state is retained.
   */
  private async start(): Promise<BrowserContext> {
    if (this.context !== undefined) return this.context
    if (this.closing) throw new Error('browser is shutting down')
    if (this.config.mode === 'cdp') {
      const url = this.config.cdpUrl ?? 'http://localhost:9222'
      this.browser = await chromium.connectOverCDP(url)
      const contexts = this.browser.contexts()
      this.context = contexts[0] ?? await this.browser.newContext()
    } else {
      const userDataDir = this.config.userDataDir ?? dshHomePath('token-saver', 'browser-profile')
      this.context = await chromium.launchPersistentContext(userDataDir, {
        channel: this.config.channel,
        headless: this.config.headless,
        args: this.config.args,
        ignoreDefaultArgs: ['--enable-automation'],
      })
      this.browser = this.context.browser() ?? undefined
    }
    return this.context
  }

  /** Get (or lazily create) the page for a provider. */
  async pageFor(provider: ProviderConfig): Promise<PageLike> {
    const existing = this.pages.get(provider.id)
    if (existing !== undefined) return existing
    const context = await this.start()
    const page = await context.newPage()
    const wrapped: PageLike = wrapPage(page)
    this.pages.set(provider.id, wrapped)
    return wrapped
  }

  /** Recreate a provider page after the user closed it. */
  async recreatePage(provider: ProviderConfig): Promise<PageLike> {
    await this.pageFor(provider)
    return this.pageFor(provider)
  }

  /** Close all pages and the browser context. CDP mode only disconnects. */
  async close(): Promise<void> {
    this.closing = true
    for (const page of this.pages.values()) {
      try {
        await page.close()
      } catch {
        /* best effort */
      }
    }
    this.pages.clear()
    if (this.context !== undefined) {
      try {
        if (this.config.mode === 'cdp') {
          await this.browser?.close().catch(() => {})
        } else {
          await this.context.close().catch(() => {})
        }
      } finally {
        this.context = undefined
        this.browser = undefined
      }
    }
  }
}

/** Wrap a Playwright Page as the minimal PageLike. */
function wrapPage(page: Page): PageLike {
  return {
    url: () => page.url(),
    locator: (selector) => wrapLocator(page.locator(selector)),
    goto: (url) => page.goto(url).then(() => undefined),
    close: () => page.close(),
  }
}

/** Wrap a Playwright Locator as the minimal LocatorLike. */
function wrapLocator(locator: ReturnType<Page['locator']>): LocatorLike {
  return {
    count: () => locator.count(),
    innerText: () => locator.innerText(),
    fill: (value) => locator.fill(value),
    click: () => locator.click(),
    keyboardType: (value) => locator.page().keyboard.type(value),
    press: (key) => locator.press(key),
    locator: (selector) => wrapLocator(locator.locator(selector)),
  }
}
