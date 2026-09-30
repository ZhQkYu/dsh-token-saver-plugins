#!/usr/bin/env node
/**
 * Discover and verify web-ai-bridge selectors for one provider (development tool).
 *
 *   node scripts/probe-web-ai.mjs <providerId> [--channel msedge|chrome] [--cdp http://127.0.0.1:9222]
 *   node scripts/probe-web-ai.mjs <providerId> --test '{"input":"...","message":"..."}'
 *
 * Discovery signs in (first run), sends a prompt whose expected answer does not
 * occur in the prompt itself, then prints: input candidates, the ancestor chain
 * of the reply text, and the buttons that were visible only while the reply was
 * generating (busy/stop candidates). `--test` runs the plugin's real ask
 * algorithm (built `lib/`) with the given selectors and prints the result.
 *
 * Stop dsh first in launch mode: the browser profile cannot be shared.
 */

import { chromium } from 'playwright-core'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import readline from 'node:readline'

const PROVIDERS = {
  deepseek: 'https://chat.deepseek.com/',
  doubao: 'https://www.doubao.com/chat/',
  qianwen: 'https://www.qianwen.com/',
  zhipu: 'https://chatglm.cn/',
  kimi: 'https://www.kimi.com/',
}
const MARKER = 'ALPHABRAVO'
const PROMPT = '请把 ALPHA 和 BRAVO 直接连写（中间不要空格），只输出这一个词。'

const [, , providerId, ...rest] = process.argv
const option = (name) => {
  const index = rest.indexOf(name)
  return index === -1 ? undefined : rest[index + 1]
}
const url = option('--url') ?? PROVIDERS[providerId]
if (!providerId || url === undefined) {
  console.error(`Usage: probe-web-ai.mjs <${Object.keys(PROVIDERS).join('|')}> [--url https://...] [--channel msedge|chrome] [--cdp URL] [--test JSON]`)
  process.exit(1)
}

const cdp = option('--cdp')
let browser
let context
if (cdp !== undefined) {
  browser = await chromium.connectOverCDP(cdp)
  context = browser.contexts()[0] ?? await browser.newContext()
} else {
  const userDataDir = dshHomePath('token-saver', 'browser-profile')
  console.log(`Launching ${option('--channel') ?? 'msedge'} with profile ${userDataDir} (stop dsh first).`)
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: option('--channel') ?? 'msedge',
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  })
}
const page = await context.newPage()
await page.goto(url)

const ask = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.question(question, (answer) => {
    rl.close()
    resolve(answer)
  })
})

await ask('\n>>> Sign in in the browser window if needed, open a fresh chat, then press Enter here... ')

const test = option('--test')
if (test !== undefined) {
  await runTest(JSON.parse(test))
} else {
  await discover()
}
await page.close()
if (browser !== undefined) await browser.close()
else await context.close()

/** Print input, reply, and busy/stop candidates. */
async function discover() {
  console.log('\n--- Input candidates (visible) ---')
  const inputs = await describeAll('textarea, [contenteditable="true"], [role="textbox"]', { visibleOnly: true })
  inputs.forEach((row, index) => console.log(`[${index}] ${row.selector}   (${row.tag})`))
  if (inputs.length === 0) {
    console.log('No visible input. Is the page signed in?')
    return
  }
  const inputSelector = inputs[inputs.length - 1].selector
  console.log(`Using input: ${inputSelector}`)

  const idleButtons = new Set((await describeAll('button, [role="button"]', { visibleOnly: true })).map(row => row.selector))
  const input = page.locator(inputSelector).last()
  await input.click()
  await page.keyboard.insertText(PROMPT)
  await page.keyboard.press('Enter')

  console.log(`\n--- Waiting up to 60s for "${MARKER}" ---`)
  const generating = new Map()
  let chain = null
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    for (const row of await describeAll('button, [role="button"]', { visibleOnly: true })) {
      if (!idleButtons.has(row.selector)) generating.set(row.selector, row)
    }
    chain = await replyChain(MARKER)
    if (chain !== null && Date.now() + 3000 < deadline) {
      await page.waitForTimeout(3000)
      break
    }
    await page.waitForTimeout(400)
  }

  console.log('\n--- Reply ancestor chain (innermost first; * marks a repeated sibling = likely message item) ---')
  if (chain === null) console.log(`"${MARKER}" did not appear.`)
  else chain.forEach(step => console.log(`${step.repeated ? '*' : ' '} ${step.selector}`))

  console.log('\n--- Buttons visible only while generating (busy / stop candidates) ---')
  const stillVisible = new Set((await describeAll('button, [role="button"]', { visibleOnly: true })).map(row => row.selector))
  for (const row of generating.values()) {
    console.log(`${stillVisible.has(row.selector) ? '  (still visible)' : ''} ${row.selector}  text=${JSON.stringify(row.text)}`)
  }
  console.log(`\nNext: pick selectors, then verify:\n  node scripts/probe-web-ai.mjs ${providerId} --test '{"input":"${inputSelector}","message":"<item selector>"}'`)
}

/** Run the plugin's ask algorithm against this page with the given selectors. */
async function runTest(selectors) {
  const { ask: askProvider } = await import('../lib/web-ai-bridge/driver.js')
  const provider = { id: providerId, displayName: providerId, url, strengths: '', enabled: true, minIntervalMs: 0, selectors }
  const pageLike = wrapPage(page)
  for (const [label, question, conversation] of [
    ['short', PROMPT, 'new'],
    ['multiline', '第一行：请记住数字 7。\n第二行：把它乘以 6，只输出结果。', 'new'],
    ['continue', '再加 1，只输出结果。', 'continue'],
  ]) {
    const started = Date.now()
    try {
      const result = await askProvider(pageLike, provider, question, conversation, {
        inputTimeoutMs: 15000, firstTokenTimeoutMs: 60000, maxWaitMs: 180000, stableMs: 2500, pollMs: 500, replyMaxChars: 20000,
      }, new AbortController().signal)
      console.log(`\n[${label}] ${Date.now() - started} ms timedOut=${result.timedOut}\n${result.text}`)
    } catch (error) {
      console.log(`\n[${label}] FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/** Describe matching elements with a compact selector each. */
async function describeAll(selector, { visibleOnly }) {
  return page.evaluate(({ selector, visibleOnly }) => {
    const cssEscape = value => (window.CSS && CSS.escape ? CSS.escape(value) : value)
    const selectorOf = (el) => {
      const tag = el.tagName.toLowerCase()
      for (const attribute of ['data-testid', 'aria-label', 'placeholder', 'name', 'role']) {
        const value = el.getAttribute(attribute)
        if (value) return `${tag}[${attribute}="${value.replace(/"/g, '\\"')}"]`
      }
      if (el.id && !/\d{3,}/.test(el.id)) return `#${cssEscape(el.id)}`
      const classes = [...el.classList].filter(name => !/\d{3,}|_[a-z0-9]{5,}$/i.test(name)).slice(0, 2)
      return classes.length > 0 ? `${tag}.${classes.map(cssEscape).join('.')}` : tag
    }
    return [...document.querySelectorAll(selector)]
      .filter(el => !visibleOnly || (el.offsetParent !== null || el.getClientRects().length > 0))
      .map(el => ({ selector: selectorOf(el), tag: el.tagName.toLowerCase(), text: (el.innerText || '').trim().slice(0, 30) }))
  }, { selector, visibleOnly })
}

/** Ancestor chain of the innermost element whose own text contains the marker. */
async function replyChain(marker) {
  return page.evaluate((markerValue) => {
    const inputs = new Set([...document.querySelectorAll('textarea, [contenteditable="true"]')])
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let hit = null
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.textContent && node.textContent.includes(markerValue) && ![...inputs].some(input => input.contains(node))) hit = node.parentElement
    }
    if (hit === null) return null
    const describe = (el) => {
      const tag = el.tagName.toLowerCase()
      const data = [...el.attributes].filter(attr => attr.name.startsWith('data-') && attr.value.length < 40).map(attr => `[${attr.name}="${attr.value}"]`).join('')
      const classes = [...el.classList].slice(0, 3).map(name => `.${name}`).join('')
      return `${tag}${classes}${data}`
    }
    const chain = []
    for (let el = hit; el !== null && el !== document.body; el = el.parentElement) {
      const signature = `${el.tagName}.${el.classList[0] ?? ''}`
      const repeated = el.parentElement !== null
        && [...el.parentElement.children].filter(child => `${child.tagName}.${child.classList[0] ?? ''}` === signature).length > 1
      chain.push({ selector: describe(el), repeated })
    }
    return chain
  }, marker)
}

/** The same PageLike adapter the plugin uses. */
function wrapPage(target) {
  const wrapLocator = locator => ({
    count: () => locator.count(),
    first: () => wrapLocator(locator.first()),
    last: () => wrapLocator(locator.last()),
    isVisible: () => locator.isVisible(),
    innerText: () => locator.innerText(),
    allInnerTexts: () => locator.allInnerTexts(),
    getAttribute: name => locator.getAttribute(name),
    fill: value => locator.fill(value),
    click: () => locator.click(),
    press: key => locator.press(key),
    locator: selector => wrapLocator(locator.locator(selector)),
  })
  return {
    url: () => target.url(),
    locator: selector => wrapLocator(target.locator(selector)),
    goto: destination => target.goto(destination).then(() => undefined),
    insertText: text => target.keyboard.insertText(text),
    isClosed: () => target.isClosed(),
    close: () => target.close(),
  }
}
