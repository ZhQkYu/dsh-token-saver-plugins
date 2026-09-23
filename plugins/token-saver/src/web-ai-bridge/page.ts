/**
 * Minimal page abstraction for the web-ai-bridge driver. This is the unit
 * boundary so the ask loop can be tested without a real browser.
 *
 * @module @dsh-plugins/token-saver/web-ai-bridge/page
 */

/** A locator handle exposing only what the driver needs. */
export interface LocatorLike {
  /** Resolve whether at least one element matches. */
  count(): Promise<number>
  /** Read the visible text of the (first) matched element. */
  innerText(): Promise<string>
  /** Fill a textarea/input with `value`. */
  fill(value: string): Promise<void>
  /** Focus the element (for contenteditable input). */
  click(): Promise<void>
  /** Type `value` into the focused element. */
  keyboardType(value: string): Promise<void>
  /** Press a key on the focused element. */
  press(key: string): Promise<void>
  /** Locate a descendant by CSS selector. */
  locator(selector: string): LocatorLike
}

/** A browser page handle, narrowed to what the driver uses. */
export interface PageLike {
  /** The current page URL. */
  url(): string
  /** Locate elements by CSS selector. */
  locator(selector: string): LocatorLike
  /** Navigate to a URL. */
  goto(url: string): Promise<void>
  /** Close the page. */
  close(): Promise<void>
}

/** A page factory the driver uses to (re)create a provider page. */
export type PageFactory = () => Promise<PageLike>
