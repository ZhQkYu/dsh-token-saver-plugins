/**
 * Browser lifecycle for the web-ai-bridge. Owns the Playwright browser/context
 * and per-provider pages: started once on first use, rebuilt after the user
 * closes a page or the browser, and closed on unload.
 *
 * @module @dsh-plugins/token-saver/web-ai-bridge/browser
 */

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core'
import type { LocatorLike, PageLike } from './page.ts'

/** Resolved browser configuration (see `resolveBrowserConfig`). */
export interface ResolvedBrowserConfig {
  mode: 'launch' | 'cdp'
  channel: 'msedge' | 'chrome'
  /** Persistent profile directory (launch mode). */
  userDataDir: string
  headless: boolean
  /** DevTools endpoint (cdp mode). */
  cdpUrl: string | undefined
  args: string[]
}

/** Teardown bound so a hung browser cannot block plugin disposal. */
const CLOSE_TIMEOUT_MS = 10_000

/** Owns the Playwright browser/context and provider pages. */
export class BrowserManager {
  private browser: Browser | undefined
  private context: BrowserContext | undefined
  private starting: Promise<BrowserContext> | undefined
  private readonly pages = new Map<string, Page>()
  private closed = false

  constructor(private readonly config: ResolvedBrowserConfig) {}

  /** Start the browser once; concurrent callers share one start. */
  private start(): Promise<BrowserContext> {
    if (this.closed) return Promise.reject(new Error('web-ai-bridge browser is shut down'))
    if (this.context !== undefined) return Promise.resolve(this.context)
    this.starting ??= this.launch().finally(() => { this.starting = undefined })
    return this.starting
  }

  private async launch(): Promise<BrowserContext> {
    let context: BrowserContext
    if (this.config.mode === 'cdp') {
      const browser = await chromium.connectOverCDP(this.config.cdpUrl ?? '')
      browser.on('disconnected', () => { this.forget(context) })
      context = browser.contexts()[0] ?? await browser.newContext()
      this.browser = browser
    } else {
      context = await chromium.launchPersistentContext(this.config.userDataDir, {
        channel: this.config.channel,
        headless: this.config.headless,
        args: this.config.args,
        ignoreDefaultArgs: ['--enable-automation'],
      })
    }
    context.on('close', () => { this.forget(context) })
    if (this.closed) {
      await this.release(context)
      throw new Error('web-ai-bridge browser is shut down')
    }
    this.context = context
    return context
  }

  /** Drop state for a context the user (or the browser) closed, so the next use starts over. */
  private forget(context: BrowserContext): void {
    if (this.context !== context) return
    this.context = undefined
    this.browser = undefined
    this.pages.clear()
  }

  /**
   * Get the provider's page, creating it (and the browser) when missing or closed.
   * @param providerId - the provider id owning the page.
   * @returns the page handle.
   */
  async pageFor(providerId: string): Promise<PageLike> {
    const existing = this.pages.get(providerId)
    if (existing !== undefined && !existing.isClosed()) return wrapPage(existing)
    const context = await this.start()
    const page = await context.newPage()
    page.on('close', () => {
      if (this.pages.get(providerId) === page) this.pages.delete(providerId)
    })
    this.pages.set(providerId, page)
    return wrapPage(page)
  }

  /** Close provider pages and the browser; cdp mode only disconnects from the user's browser. */
  async close(): Promise<void> {
    this.closed = true
    const context = this.context ?? await this.starting?.then(value => value, () => undefined)
    if (context === undefined) return
    await Promise.race([
      this.release(context),
      new Promise<void>(resolve => { setTimeout(resolve, CLOSE_TIMEOUT_MS).unref() }),
    ])
  }

  private async release(context: BrowserContext): Promise<void> {
    const pages = [...this.pages.values()]
    this.pages.clear()
    this.context = undefined
    if (this.config.mode === 'cdp') {
      await Promise.allSettled(pages.map(page => page.close()))
      await this.browser?.close().then(() => undefined, () => undefined)
      this.browser = undefined
      return
    }
    await context.close().then(() => undefined, () => undefined)
  }
}

/** Wrap a Playwright Page as the minimal PageLike. */
function wrapPage(page: Page): PageLike {
  return {
    url: () => page.url(),
    locator: selector => wrapLocator(page.locator(selector)),
    goto: url => page.goto(url).then(() => undefined),
    insertText: text => page.keyboard.insertText(text),
    isClosed: () => page.isClosed(),
    close: () => page.close(),
  }
}

/** Wrap a Playwright Locator as the minimal LocatorLike. */
function wrapLocator(locator: Locator): LocatorLike {
  return {
    count: () => locator.count(),
    first: () => wrapLocator(locator.first()),
    last: () => wrapLocator(locator.last()),
    isVisible: () => locator.isVisible(),
    innerText: () => locator.innerText(),
    allInnerTexts: () => locator.allInnerTexts(),
    fill: value => locator.fill(value),
    click: () => locator.click(),
    press: key => locator.press(key),
    locator: selector => wrapLocator(locator.locator(selector)),
  }
}
