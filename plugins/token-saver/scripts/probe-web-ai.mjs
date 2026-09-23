#!/usr/bin/env node
/**
 * Probe a web-AI provider page to discover stable CSS selectors for the
 * web-ai-bridge. Usage:
 *
 *   node scripts/probe-web-ai.mjs <providerId> [--channel msedge|chrome]
 *
 * It launches a headful browser in the plugin's persistent profile, prompts you
 * to sign in, then discovers the input, send button, reply container, and stop
 * button. Requires the provider to be configured in cordis.patch.yml with a
 * `url`; the script reads selectors from the CLI first and prints candidates.
 *
 * This is a development tool; it is not part of the plugin runtime.
 */

import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'

const [, , providerId, ...rest] = process.argv
const channelFlag = rest.find(arg => arg === '--channel')
const channel = channelFlag ? rest[rest.indexOf(channelFlag) + 1] : 'msedge'

const providers = {
  deepseek: { url: 'https://chat.deepseek.com/' },
  doubao: { url: 'https://www.doubao.com/chat/' },
  qianwen: { url: 'https://chat.qwen.ai/' },
  zhipu: { url: 'https://chatglm.cn/' },
  kimi: { url: 'https://www.kimi.com/' },
}

if (!providerId || !providers[providerId]) {
  console.error(`Unknown provider "${providerId}". Known: ${Object.keys(providers).join(', ')}`)
  process.exit(1)
}

const userDataDir = path.join(os.homedir(), '.dsh', 'token-saver', 'browser-profile')
console.log(`Starting headful ${channel} with profile ${userDataDir}`)
console.log('NOTE: make sure dsh is stopped so no other process uses this profile.')

const context = await chromium.launchPersistentContext(userDataDir, {
  channel,
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],
})
const page = context.pages()[0] ?? await context.newPage()
await page.goto(providers[providerId].url)

console.log('\n>>> Sign in in the opened browser window, then press Enter here when ready.')
await new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.question('Press Enter after signing in...', () => {
    rl.close()
    resolve()
  })
})

console.log('\n--- Input candidates ---')
const textareas = await page.locator('textarea').count()
console.log(`textarea count: ${textareas}`)
const contenteditables = await page.locator('[contenteditable="true"]').count()
console.log(`[contenteditable="true"] count: ${contenteditables}`)
if (textareas > 0) {
  const first = page.locator('textarea').first()
  console.log(`textarea[0] selector: ${await selectorOf(page, 'textarea')}`)
  console.log('Using textarea as input.')
  await first.click()
  await page.keyboard.type('Please only reply: 收到')
  await page.keyboard.press('Enter')
} else if (contenteditables > 0) {
  const first = page.locator('[contenteditable="true"]').first()
  console.log(`contenteditable[0] selector: ${await selectorOf(page, '[contenteditable="true"]')}`)
  await first.click()
  await page.keyboard.type('Please only reply: 收到')
  await page.keyboard.press('Enter')
} else {
  console.log('No input found. Adjust selectors manually.')
}

console.log('\n--- Send button candidates (aria-label / role=button with text) ---')
const buttons = page.locator('button[aria-label], button[role="button"]')
const n = Math.min(await buttons.count(), 20)
for (let i = 0; i < n; i++) {
  const btn = buttons.nth(i)
  try {
    const label = await btn.getAttribute('aria-label')
    const text = (await btn.innerText()).slice(0, 40)
    const sel = await selectorOf(page, `button[aria-label="${label}"]`)
    console.log(`[${i}] aria-label=${JSON.stringify(label)} text=${JSON.stringify(text)} selector=${sel}`)
  } catch {
    /* skip */
  }
}

console.log('\n--- Waiting 20s for a reply ---')
await page.waitForTimeout(20000)

console.log('\n--- Reply container candidates (elements containing 收到) ---')
const found = await findDeepestContaining(page, '收到')
console.log(found ?? 'No element containing 收到 found.')

console.log('\n--- Stop button candidates while generating ---')
const stopButtons = page.locator('button:has-text("停止"), button:has-text("Stop")')
console.log(`stop button count: ${await stopButtons.count()}`)

console.log('\nDONE. Paste the discovered selectors into cordis.patch.yml providers.')

await context.close()

/** Build a compact, stable selector for an element. */
async function selectorOf(page, selector) {
  const locator = page.locator(selector).first()
  try {
    const tag = await locator.evaluate(el => el.tagName.toLowerCase())
    const id = await locator.getAttribute('id')
    if (id) return `#${id}`
    const aria = await locator.getAttribute('aria-label')
    if (aria) return `${tag}[aria-label="${aria}"]`
    return tag
  } catch {
    return selector
  }
}

/** Find the deepest element whose innerText contains the marker. */
async function findDeepestContaining(page, marker) {
  return page.evaluate((markerValue) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    let deepest = null
    let deepestDepth = -1
    while (walker.nextNode()) {
      const el = walker.currentNode
      if (el.innerText && el.innerText.includes(markerValue)) {
        let depth = 0
        let parent = el.parentElement
        while (parent) {
          depth++
          parent = parent.parentElement
        }
        if (depth > deepestDepth) {
          deepestDepth = depth
          deepest = el
        }
      }
    }
    if (!deepest) return null
    const path = []
    let el = deepest
    while (el && el !== document.body) {
      const tag = el.tagName.toLowerCase()
      const cls = el.className && typeof el.className === 'string' ? el.className.split(/\s+/).slice(0, 2).join('.') : ''
      const aria = el.getAttribute && el.getAttribute('aria-label')
      const dataTest = el.getAttribute && el.getAttribute('data-testid')
      path.push(`${tag}${cls ? '.' + cls : ''}${aria ? `[aria-label="${aria}"]` : ''}${dataTest ? `[data-testid="${dataTest}"]` : ''}`)
      el = el.parentElement
    }
    return path.join(' > ')
  }, marker)
}
