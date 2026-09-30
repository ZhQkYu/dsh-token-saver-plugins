/**
 * Provider configuration and the ask algorithm for the web-ai-bridge. The ask
 * loop is pure over the page abstraction so it is unit-testable.
 *
 * @module @dsh-plugins/token-saver/web-ai-bridge/driver
 */

import type { LocatorLike, PageLike } from './page.ts'
import type { AgentConfig } from './agent.ts'

/** CSS selectors for one web-AI provider page. */
export interface SelectorSet {
  /** The message input (textarea or contenteditable). */
  input: string
  /** Optional send button; when absent the driver presses Enter. */
  send?: string
  /** Assistant reply containers; the last match is the newest reply. */
  message: string
  /** Optional selector inside a reply for its answer body, excluding reasoning text. */
  messageContent?: string
  /** Optional "generating" indicator (e.g. a stop button). */
  busy?: string
  /** Optional stop button used on cancel. */
  stop?: string
  /** Optional new-chat button; when absent the driver re-opens the URL. */
  newChat?: string
  /** When present and visible, the user is logged out. */
  loggedOut?: string
}

/**
 * A provider page switch (e.g. deep thinking, web search) the driver sets before
 * each ask. Its state is read from `aria-pressed`, falling back to `aria-checked`.
 */
export interface ToggleConfig {
  /** Display name used in logs and errors. */
  name: string
  /** CSS selector for the switch element. */
  selector: string
  /** Desired state: true turns the switch on, false turns it off. */
  enabled: boolean
}

/** One configured web-AI provider. */
export interface ProviderConfig {
  /** Provider id; `^[a-z0-9-]{1,32}$`. */
  id: string
  /** Human-readable display name. */
  displayName: string
  /** Provider start URL (https). */
  url: string
  /** Model-facing strengths description. */
  strengths: string
  /** Whether the provider is enabled. */
  enabled: boolean
  /** CSS selectors for this provider. */
  selectors: SelectorSet
  /** Switches set to their desired state before each ask; a missing switch is skipped. */
  toggles?: ToggleConfig[]
  /** Agent mode; when enabled, web_ai_ask runs a local read-only ReAct loop driven by this provider. */
  agent?: AgentConfig
  /** Minimum interval between asks to the same provider, in ms. */
  minIntervalMs: number
}

/** Ask timing bounds, all in milliseconds. */
export interface AskTimings {
  /** How long to wait for the input box after opening the conversation. */
  inputTimeoutMs: number
  /** How long to wait for a new reply to appear after sending. */
  firstTokenTimeoutMs: number
  /** Total bound for one ask, measured from its start. */
  maxWaitMs: number
  /** How long the reply text must stay unchanged to count as complete. */
  stableMs: number
  /** Page polling interval. */
  pollMs: number
  /** Maximum reply characters returned. */
  replyMaxChars: number
}

/** The result of one ask. */
export interface AskResult {
  text: string
  truncated: boolean
  /** The reply was still changing (or the provider still busy) when `maxWaitMs` elapsed. */
  timedOut: boolean
  elapsedMs: number
}

/** Stable failure codes surfaced to the model. */
export type WebAiErrorCode = 'NOT_LOGGED_IN' | 'ABORTED' | 'TIMEOUT'

/** Errors surfaced to the model, with a stable `code` prefix in the message. */
export class WebAiError extends Error {
  constructor(readonly code: WebAiErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'WebAiError'
  }
}

const visible = (locator: LocatorLike): Promise<boolean> => locator.first().isVisible().then(value => value, () => false)

const countOf = (locator: LocatorLike): Promise<number> => locator.count().then(value => value, () => 0)

function sameOrigin(current: string, target: string): boolean {
  try {
    return new URL(current).origin === new URL(target).origin
  } catch (invalidUrl: unknown) {
    // A blank or special page (about:blank) has no comparable origin.
    return false
  }
}

function aborted(): WebAiError {
  return new WebAiError('ABORTED', 'ask cancelled')
}

/**
 * Sleep for `ms`, rejecting as soon as `signal` aborts.
 * @param ms - delay in milliseconds.
 * @param signal - cancellation.
 */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(aborted())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(aborted())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Poll `condition` until it holds or `timeoutMs` elapses. */
async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, pollMs: number, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    if (await condition()) return true
    if (Date.now() >= deadline) return false
    await delay(pollMs, signal)
  }
}

/** Open a fresh conversation, or make sure the provider page is loaded for `continue`. */
async function openConversation(page: PageLike, provider: ProviderConfig, conversation: 'new' | 'continue'): Promise<void> {
  const loaded = sameOrigin(page.url(), provider.url)
  if (conversation === 'continue') {
    if (!loaded) await page.goto(provider.url)
    return
  }
  if (loaded && provider.selectors.newChat !== undefined && provider.selectors.newChat !== '') {
    const button = page.locator(provider.selectors.newChat).first()
    if (await visible(button) && await button.click().then(() => true, () => false)) return
  }
  await page.goto(provider.url)
}

/** Read a switch's on/off state, or `undefined` when it exposes none. */
async function toggleState(toggle: LocatorLike): Promise<boolean | undefined> {
  for (const name of ['aria-pressed', 'aria-checked']) {
    const value = await toggle.getAttribute(name).then(v => v, () => null)
    if (value === 'true') return true
    if (value === 'false') return false
  }
  return undefined
}

/**
 * Set each configured switch to its desired state. A switch that is absent or
 * exposes no state is left alone, so page redesigns never block an ask.
 */
async function applyToggles(page: PageLike, provider: ProviderConfig, timings: AskTimings, signal: AbortSignal): Promise<void> {
  for (const config of provider.toggles ?? []) {
    const toggle = page.locator(config.selector).first()
    if (!await visible(toggle)) continue
    const state = await toggleState(toggle)
    if (state === undefined || state === config.enabled) continue
    if (!await toggle.click().then(() => true, () => false)) continue
    await waitFor(async () => await toggleState(toggle) === config.enabled, timings.inputTimeoutMs, timings.pollMs, signal)
  }
}

/** Read the newest reply's answer text, or `undefined` when it could not be read this poll. */
async function readReply(message: LocatorLike, provider: ProviderConfig): Promise<string | undefined> {
  const last = message.last()
  const contentSelector = provider.selectors.messageContent
  if (contentSelector !== undefined && contentSelector !== '') {
    const content = last.locator(contentSelector)
    if (await countOf(content) > 0) {
      return content.allInnerTexts().then(texts => texts.join('\n').trim(), () => undefined)
    }
  }
  return last.innerText().then(text => text.trim(), () => undefined)
}

/**
 * The ask algorithm: open the conversation, fill and send the prompt, wait for
 * a new reply, and poll until it stops changing or `maxWaitMs` elapses.
 * @param page - the provider page.
 * @param provider - provider config.
 * @param prompt - the question to ask.
 * @param conversation - 'new' starts a fresh conversation; 'continue' reuses the open one.
 * @param timings - timing bounds.
 * @param signal - cancellation; aborting clicks the provider's stop button when configured.
 * @returns the reply text and status.
 */
export async function ask(
  page: PageLike,
  provider: ProviderConfig,
  prompt: string,
  conversation: 'new' | 'continue',
  timings: AskTimings,
  signal: AbortSignal,
): Promise<AskResult> {
  const start = Date.now()
  if (signal.aborted) throw aborted()
  await openConversation(page, provider, conversation)

  const selectors = provider.selectors
  const input = page.locator(selectors.input).first()
  const inputReady = await waitFor(async () => {
    if (selectors.loggedOut !== undefined && selectors.loggedOut !== '' && await visible(page.locator(selectors.loggedOut))) {
      throw new WebAiError('NOT_LOGGED_IN', `${provider.displayName} shows its sign-in prompt. Call web_ai_open and ask the user to sign in.`)
    }
    return visible(input)
  }, timings.inputTimeoutMs, timings.pollMs, signal)
  if (!inputReady) {
    throw new WebAiError('NOT_LOGGED_IN', `No input box appeared on ${provider.displayName}. Call web_ai_open and ask the user to sign in.`)
  }

  const message = page.locator(selectors.message)
  // A single-page app may still show the previous chat right after "new chat"; let it clear first.
  if (conversation === 'new') await waitFor(async () => await countOf(message) === 0, timings.inputTimeoutMs, timings.pollMs, signal)
  const before = await countOf(message)
  await applyToggles(page, provider, timings, signal)

  await input.click()
  if (!await input.fill(prompt).then(() => true, () => false)) await page.insertText(prompt)
  const send = selectors.send !== undefined && selectors.send !== '' ? page.locator(selectors.send).first() : undefined
  if (send !== undefined && await visible(send)) await send.click()
  else await input.press('Enter')

  const started = await waitFor(async () => await countOf(message) > before, timings.firstTokenTimeoutMs, timings.pollMs, signal)
  if (!started) {
    throw new WebAiError('TIMEOUT', `${provider.displayName} did not start replying within ${timings.firstTokenTimeoutMs} ms.`)
  }

  let text = ''
  let lastChange = Date.now()
  let complete = false
  while (Date.now() - start < timings.maxWaitMs) {
    if (signal.aborted) {
      if (selectors.stop !== undefined && selectors.stop !== '') {
        const stop = page.locator(selectors.stop).first()
        if (await visible(stop)) await stop.click().then(() => undefined, () => undefined)
      }
      throw aborted()
    }
    const current = await readReply(message, provider)
    if (current !== undefined && current !== text) {
      text = current
      lastChange = Date.now()
    }
    const busy = selectors.busy !== undefined && selectors.busy !== '' && await visible(page.locator(selectors.busy))
    if (!busy && text !== '' && Date.now() - lastChange >= timings.stableMs) {
      complete = true
      break
    }
    await delay(timings.pollMs, signal).catch((error: unknown) => {
      // Abort is handled at the top of the loop so the stop button is still clicked.
      if (!(error instanceof WebAiError)) throw error
    })
  }
  const truncated = text.length > timings.replyMaxChars
  return {
    text: truncated ? `${text.slice(0, timings.replyMaxChars)}\n[reply truncated]` : text,
    truncated,
    timedOut: !complete,
    elapsedMs: Date.now() - start,
  }
}
