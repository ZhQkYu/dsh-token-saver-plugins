import { describe, expect, it } from 'vitest'
import { ask, WebAiError, type AskTimings, type ProviderConfig } from '../src/web-ai-bridge/driver.ts'
import type { LocatorLike, PageLike } from '../src/web-ai-bridge/page.ts'

/** Mutable fake page state; selectors are the plain keys below. */
interface FakeDom {
  url: string
  inputVisible: boolean
  loggedOut: boolean
  busy: boolean
  stopVisible: boolean
  newChatVisible: boolean
  fillFails: boolean
  messages: string[]
  /** Called after a prompt is sent; drives the fake reply. */
  onSend: (dom: FakeDom) => void
}

interface FakeLog {
  gotos: string[]
  filled: string[]
  inserted: string[]
  clicks: string[]
  presses: string[]
}

function fakePage(dom: FakeDom): { page: PageLike; log: FakeLog } {
  const log: FakeLog = { gotos: [], filled: [], inserted: [], clicks: [], presses: [] }
  const send = (): void => { dom.onSend(dom) }
  const elements = (selector: string): { text: string; visible: boolean }[] => {
    switch (selector) {
      case 'input': return dom.inputVisible ? [{ text: '', visible: true }] : []
      case 'out': return dom.loggedOut ? [{ text: 'Sign in', visible: true }] : []
      case 'busy': return dom.busy ? [{ text: '', visible: true }] : []
      case 'stop': return dom.stopVisible ? [{ text: 'Stop', visible: true }] : []
      case 'new': return dom.newChatVisible ? [{ text: 'New chat', visible: true }] : []
      case 'send': return [{ text: 'Send', visible: true }]
      case 'msg': return dom.messages.map(text => ({ text, visible: true }))
      default: return []
    }
  }
  const locator = (selector: string, pick?: 'first' | 'last'): LocatorLike => {
    const matched = (): { text: string; visible: boolean }[] => {
      const all = elements(selector)
      if (pick === 'first') return all.slice(0, 1)
      if (pick === 'last') return all.slice(-1)
      return all
    }
    const single = (): { text: string; visible: boolean } => {
      const all = matched()
      if (all.length !== 1) throw new Error(`strict mode violation: ${selector} matched ${all.length}`)
      return all[0]!
    }
    return {
      count: async () => matched().length,
      first: () => locator(selector, 'first'),
      last: () => locator(selector, 'last'),
      isVisible: async () => {
        const all = matched()
        if (all.length > 1) throw new Error('strict mode violation')
        return all[0]?.visible ?? false
      },
      innerText: async () => single().text,
      allInnerTexts: async () => matched().map(element => element.text),
      fill: async (value) => {
        single()
        if (dom.fillFails) throw new Error('not fillable')
        log.filled.push(value)
      },
      click: async () => {
        single()
        log.clicks.push(selector)
        if (selector === 'send') send()
        if (selector === 'new') dom.messages = []
        if (selector === 'stop') dom.busy = false
      },
      press: async (key) => {
        single()
        log.presses.push(key)
        if (key === 'Enter') send()
      },
      locator: () => locator('none'),
    }
  }
  const page: PageLike = {
    url: () => dom.url,
    locator: selector => locator(selector),
    goto: async (url) => {
      log.gotos.push(url)
      dom.url = url
      dom.messages = []
    },
    insertText: async (text) => { log.inserted.push(text) },
    isClosed: () => false,
    close: async () => undefined,
  }
  return { page, log }
}

function dom(overrides: Partial<FakeDom> = {}): FakeDom {
  return {
    url: 'https://ai.example/',
    inputVisible: true,
    loggedOut: false,
    busy: false,
    stopVisible: false,
    newChatVisible: false,
    fillFails: false,
    messages: [],
    onSend: (state) => { state.messages.push('done') },
    ...overrides,
  }
}

const provider = (selectors: Partial<ProviderConfig['selectors']> = {}): ProviderConfig => ({
  id: 'fake',
  displayName: 'Fake AI',
  url: 'https://ai.example/',
  strengths: 'testing',
  enabled: true,
  minIntervalMs: 0,
  selectors: { input: 'input', message: 'msg', ...selectors },
})

const timings: AskTimings = { inputTimeoutMs: 60, firstTokenTimeoutMs: 80, maxWaitMs: 400, stableMs: 30, pollMs: 5, replyMaxChars: 1000 }

const signal = (): AbortSignal => new AbortController().signal

describe('ask', () => {
  it('waits for a growing reply to stabilize and returns only the newest reply', async () => {
    const state = dom({
      messages: ['old answer'],
      onSend: (current) => {
        current.messages.push('')
        const chunks = ['He', 'Hello', 'Hello world']
        chunks.forEach((chunk, index) => setTimeout(() => { current.messages[current.messages.length - 1] = chunk }, 10 * (index + 1)))
      },
    })
    const { page } = fakePage(state)
    const result = await ask(page, provider(), 'hi', 'continue', timings, signal())
    expect(result).toMatchObject({ text: 'Hello world', timedOut: false, truncated: false })
  })

  it('reports timedOut with the partial text while the provider stays busy', async () => {
    const state = dom({ onSend: (current) => { current.messages.push('partial'); current.busy = true } })
    const { page } = fakePage(state)
    const result = await ask(page, provider({ busy: 'busy' }), 'hi', 'continue', { ...timings, maxWaitMs: 120 }, signal())
    expect(result.timedOut).toBe(true)
    expect(result.text).toBe('partial')
  })

  it('fails with TIMEOUT instead of returning the previous reply when no new reply starts', async () => {
    const state = dom({ messages: ['old answer'], onSend: () => undefined })
    const { page } = fakePage(state)
    await expect(ask(page, provider(), 'hi', 'continue', timings, signal())).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('reports NOT_LOGGED_IN when the input never appears or the sign-in prompt shows', async () => {
    await expect(ask(fakePage(dom({ inputVisible: false })).page, provider(), 'hi', 'continue', timings, signal()))
      .rejects.toMatchObject({ code: 'NOT_LOGGED_IN' })
    await expect(ask(fakePage(dom({ loggedOut: true })).page, provider({ loggedOut: 'out' }), 'hi', 'continue', timings, signal()))
      .rejects.toMatchObject({ code: 'NOT_LOGGED_IN' })
  })

  it('opens a new conversation by URL when no new-chat button is configured', async () => {
    const { page, log } = fakePage(dom({ messages: ['old'] }))
    const result = await ask(page, provider(), 'hi', 'new', timings, signal())
    expect(log.gotos).toEqual(['https://ai.example/'])
    expect(result.text).toBe('done')
  })

  it('uses the new-chat button when it is visible', async () => {
    const { page, log } = fakePage(dom({ messages: ['old'], newChatVisible: true }))
    await ask(page, provider({ newChat: 'new' }), 'hi', 'new', timings, signal())
    expect(log.clicks).toContain('new')
    expect(log.gotos).toEqual([])
  })

  it('inserts text without key events when fill is unsupported, then sends with the button', async () => {
    const { page, log } = fakePage(dom({ fillFails: true }))
    await ask(page, provider({ send: 'send' }), 'line one\nline two', 'continue', timings, signal())
    expect(log.inserted).toEqual(['line one\nline two'])
    expect(log.presses).toEqual([])
    expect(log.clicks).toContain('send')
  })

  it('clicks stop and fails with ABORTED when cancelled mid-reply', async () => {
    const controller = new AbortController()
    const state = dom({ onSend: (current) => { current.messages.push('thinking'); current.busy = true; current.stopVisible = true } })
    const { page, log } = fakePage(state)
    setTimeout(() => controller.abort(), 30)
    const error = await ask(page, provider({ busy: 'busy', stop: 'stop' }), 'hi', 'continue', timings, controller.signal).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(WebAiError)
    expect((error as WebAiError).code).toBe('ABORTED')
    expect(log.clicks).toContain('stop')
  })

  it('truncates long replies', async () => {
    const { page } = fakePage(dom({ onSend: (current) => { current.messages.push('x'.repeat(50)) } }))
    const result = await ask(page, provider(), 'hi', 'continue', { ...timings, replyMaxChars: 10 }, signal())
    expect(result.truncated).toBe(true)
    expect(result.text.startsWith('x'.repeat(10))).toBe(true)
  })
})
