/**
 * Minimal page abstraction for the web-ai-bridge driver. This is the unit
 * boundary so the ask loop can be tested without a real browser. Single-element
 * reads go through `first()`/`last()`, because Playwright locators are strict
 * and reject reads that match more than one element.
 *
 * @module @dsh-plugins/token-saver/web-ai-bridge/page
 */

/** A locator handle exposing only what the driver needs. */
export interface LocatorLike {
  /** Number of matched elements. */
  count(): Promise<number>
  /** The first matched element. */
  first(): LocatorLike
  /** The last matched element. */
  last(): LocatorLike
  /** Whether the (single) matched element is visible; false when none matches. */
  isVisible(): Promise<boolean>
  /** Visible text of the (single) matched element. */
  innerText(): Promise<string>
  /** Visible text of every matched element, in document order. */
  allInnerTexts(): Promise<string[]>
  /** Replace the value of a textarea, input, or contenteditable. */
  fill(value: string): Promise<void>
  /** An attribute of the (single) matched element, or null when absent. */
  getAttribute(name: string): Promise<string | null>
  /** Click the (single) matched element. */
  click(): Promise<void>
  /** Press a key on the (single) matched element. */
  press(key: string): Promise<void>
  /** Locate descendants by CSS selector. */
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
  /** Insert text at the focused element without key events, so newlines never submit. */
  insertText(text: string): Promise<void>
  /** Whether the page was closed. */
  isClosed(): boolean
  /** Close the page. */
  close(): Promise<void>
}
