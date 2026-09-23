/**
 * Provider configuration and the ask algorithm for the web-ai-bridge. The ask
 * loop is pure over the page abstraction so it is unit-testable.
 *
 * @module @dsh-plugins/token-saver/web-ai-bridge/driver
 */

import { LocatorLike, PageLike } from './page.ts'

/** CSS selectors for one web-AI provider page. */
export interface SelectorSet {
  /** The message input (textarea or contenteditable). */
  input: string
  /** Optional send button; when absent the driver presses Enter. */
  send?: string
  /** The assistant reply message container (last one wins). */
  message: string
  /** Optional container-inner body selector to exclude reasoning text. */
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

/** One configured web-AI provider. */
export interface ProviderConfig {
  /** Provider id; `^[a-z0-9-]{1,32}$`. */
  id: string
  /** Human-readable display name. */
  displayName: string
  /** Provider URL. */
  url: string
  /** Model-facing strengths description. */
  strengths: string
  /** Whether the provider is enabled. */
  enabled: boolean
  /** CSS selectors for this provider. */
  selectors: SelectorSet
  /** Minimum interval between asks to the same provider, in ms. */
  minIntervalMs: number
}

/** The result of one ask. */
export interface AskResult {
  text: string
  truncated: boolean
  timedOut: boolean
  elapsedMs: number
}

/** A cancellation token. */
export interface AskSignal {
  readonly aborted: boolean
  addListener(listener: () => void): void
  removeListener(listener: () => void): void
}

/** A per-provider mutex that serializes asks. */
export interface Mutex {
  run<T>(task: () => Promise<T>): Promise<T>
}

/** Errors surfaced to the model, with a stable `code`. */
export class WebAiError extends Error {
  constructor(readonly code: 'NOT_LOGGED_IN' | 'NO_INPUT' | 'ABORTED' | 'TIMEOUT', message: string) {
    super(message)
    this.name = 'WebAiError'
  }
}

const isVisible = async (locator: LocatorLike): Promise<boolean> => {
  try {
    return (await locator.count()) > 0
  } catch {
    return false
  }
}

/**
 * The ask algorithm. Fills the provider input, sends, waits for a new reply,
 * and polls until the reply stabilizes or the timeout elapses.
 * @param page - the provider page.
 * @param provider - provider config.
 * @param prompt - the question to ask.
 * @param conversation - 'new' starts a fresh conversation.
 * @param opts - timings.
 * @param signal - cancellation.
 * @param afterAsk - optional hook (for tests) after the reply stabilizes.
 * @returns the reply text and status.
 */
export async function ask(
  page: PageLike,
  provider: ProviderConfig,
  prompt: string,
  conversation: 'new' | 'continue',
  opts: {
    firstTokenTimeoutMs: number
    maxWaitMs: number
    stableMs: number
    pollMs: number
    replyMaxChars: number
  },
  signal: AskSignal,
  afterAsk?: (text: string, timedOut: boolean) => void,
): Promise<AskResult> {
  const start = Date.now()
  if (conversation === 'new' && provider.selectors.newChat) {
    const newChat = page.locator(provider.selectors.newChat)
    if (await isVisible(newChat)) {
      try {
        await newChat.click()
      } catch {
        /* fall through to goto */
      }
    } else {
      await page.goto(provider.url)
    }
  } else if (!page.url().startsWith(new URL(provider.url).origin)) {
    await page.goto(provider.url)
  }

  if (provider.selectors.loggedOut && await isVisible(page.locator(provider.selectors.loggedOut))) {
    throw new WebAiError('NOT_LOGGED_IN', `You appear to be logged out of ${provider.displayName}. Call web_ai_open to sign in.`)
  }

  const input = page.locator(provider.selectors.input)
  if (!(await isVisible(input))) {
    // Wait a short grace period for the input to appear.
    const deadline = start + 15000
    while (Date.now() < deadline) {
      if (await isVisible(input)) break
      await delay(200, signal)
    }
    if (!(await isVisible(input))) {
      throw new WebAiError('NOT_LOGGED_IN', `No input box appeared for ${provider.displayName}. Call web_ai_open to sign in.`)
    }
  }

  const before = await countMessages(page, provider.selectors.message)
  await fillInput(input, prompt)
  if (provider.selectors.send) {
    const send = page.locator(provider.selectors.send)
    if (await isVisible(send)) await send.click()
    else await input.press('Enter')
  } else {
    await input.press('Enter')
  }

  // Wait for the reply count to increase (first token).
  const firstDeadline = start + opts.firstTokenTimeoutMs
  while (Date.now() < firstDeadline) {
    if (await countMessages(page, provider.selectors.message) > before) break
    if (signal.aborted) throw new WebAiError('ABORTED', 'ask cancelled')
    await delay(opts.pollMs, signal)
  }

  // Poll until stable.
  let lastText = ''
  let lastChange = Date.now()
  let timedOut = false
  let text = ''
  while (Date.now() - start < opts.maxWaitMs) {
    if (signal.aborted) {
      await clickStop(page, provider)
      throw new WebAiError('ABORTED', 'ask cancelled')
    }
    const current = await readReply(page, provider)
    if (current !== lastText) {
      lastText = current
      lastChange = Date.now()
    }
    const busy = provider.selectors.busy !== undefined && await isVisible(page.locator(provider.selectors.busy))
    if (!busy && Date.now() - lastChange >= opts.stableMs) {
      text = lastText
      break
    }
    await delay(opts.pollMs, signal)
  }
  if (text === '') {
    text = lastText
  }
  if (text === '') {
    timedOut = true
  } else if (Date.now() - start >= opts.maxWaitMs && text !== lastText) {
    // still growing at the deadline
  }
  const elapsedMs = Date.now() - start
  const truncated = text.length > opts.replyMaxChars
  const clipped = truncated ? `${text.slice(0, opts.replyMaxChars)}\n[reply truncated]` : text
  afterAsk?.(clipped, timedOut)
  return { text: clipped, truncated, timedOut, elapsedMs }
}

/** Count assistant messages matching the message selector. */
async function countMessages(page: PageLike, selector: string): Promise<number> {
  try {
    return await page.locator(selector).count()
  } catch {
    return 0
  }
}

/** Read the last assistant message text, narrowing to the content selector when present. */
async function readReply(page: PageLike, provider: ProviderConfig): Promise<string> {
  const message = page.locator(provider.selectors.message)
  const count = await message.count()
  if (count === 0) return ''
  const last = page.locator(`${provider.selectors.message}:last-of-type`)
  if (provider.selectors.messageContent) {
    const content = last.locator(provider.selectors.messageContent)
    if (await isVisible(content)) return (await content.innerText()).trim()
  }
  try {
    return (await last.innerText()).trim()
  } catch {
    return ''
  }
}

/** Fill a textarea/input or contenteditable. */
async function fillInput(input: LocatorLike, prompt: string): Promise<void> {
  try {
    await input.fill(prompt)
  } catch {
    await input.click()
    await input.keyboardType(prompt)
  }
}

/** Click the stop button if configured, to interrupt generation on cancel. */
async function clickStop(page: PageLike, provider: ProviderConfig): Promise<void> {
  if (provider.selectors.stop) {
    try {
      const stop = page.locator(provider.selectors.stop)
      if (await isVisible(stop)) await stop.click()
    } catch {
      /* best effort */
    }
  }
}

/** A cancellable sleep. */
function delay(ms: number, signal: AskSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new WebAiError('ABORTED', 'ask cancelled'))
      return
    }
    const timer = setTimeout(() => {
      signal.removeListener(onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new WebAiError('ABORTED', 'ask cancelled'))
    }
    signal.addListener(onAbort)
  })
}
