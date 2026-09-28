/**
 * SSRF-guarded fetch for the http node. Resolves the host and rejects private /
 * loopback / link-local addresses, pins the resolved address in an undici Agent
 * (preventing DNS rebinding), and follows at most 5 redirects with re-checks.
 *
 * @module @dsh-plugins/flow/host/services/guarded-fetch
 */

import { lookup } from 'node:dns/promises'
import net from 'node:net'
import { Agent, request as undiciRequest } from 'undici'

/** Configuration for the guarded fetch. */
export interface GuardedFetchConfig {
  timeoutMs: number
  maxResponseBytes: number
  allowPrivateNetwork: boolean
  allowedHosts: string[]
}

/** A guarded fetch result. */
export interface GuardedFetchResult {
  status: number
  headers: Record<string, string>
  body: string
  json: import('../../spec/types.ts').JsonValue
}

/** The error thrown on a blocked request. */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlockedUrlError'
  }
}

/** Build a guarded fetch function. */
export function createGuardedFetch(config: GuardedFetchConfig): (request: Request, options: { timeoutMs: number; maxResponseBytes: number }) => Promise<GuardedFetchResult> {
  return async (request, options) => {
    const url = new URL(request.url)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new BlockedUrlError(`unsupported protocol ${url.protocol}`)
    }
    const host = url.hostname
    if (config.allowPrivateNetwork || isAllowedHost(host, config.allowedHosts)) {
      return await doFetch(url, request, options, config)
    }
    const addresses = await lookup(host, { all: true, verbatim: true })
    if (addresses.length === 0) throw new BlockedUrlError(`no addresses for ${host}`)
    for (const address of addresses) {
      if (!isPublicIp(address.address)) {
        throw new BlockedUrlError(`address ${address.address} for ${host} is not public`)
      }
    }
    return await doFetch(url, request, options, config, addresses[0]?.address)
  }
}

async function doFetch(url: URL, request: Request, options: { timeoutMs: number; maxResponseBytes: number }, config: GuardedFetchConfig, pinnedAddress?: string): Promise<GuardedFetchResult> {
  let currentUrl = url
  const method = request.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  let body: string | undefined
  if (request.body !== null && request.body !== undefined) {
    body = await request.text()
  }
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => { headers[key] = value })

  const agent = new Agent(pinnedAddress === undefined ? {} : { connect: { lookup: createPinnedLookup(pinnedAddress) } })
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const response = await undiciRequest(currentUrl, {
        method,
        headers,
        body,
        maxRedirections: 0,
        headersTimeout: options.timeoutMs,
        bodyTimeout: options.timeoutMs,
        ...(hop === 0 ? { dispatcher: agent } : {}),
      })
      const location = response.headers['location']
      if (response.statusCode >= 300 && response.statusCode < 400 && location !== undefined) {
        const nextUrl = new URL(location, currentUrl)
        if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
          throw new BlockedUrlError(`redirect to unsupported protocol ${nextUrl.protocol}`)
        }
        const nextHost = nextUrl.hostname
        if (!config.allowPrivateNetwork && !isAllowedHost(nextHost, config.allowedHosts)) {
          const addresses = await lookup(nextHost, { all: true, verbatim: true })
          for (const address of addresses) {
            if (!isPublicIp(address.address)) throw new BlockedUrlError(`redirect to private address ${address.address}`)
          }
        }
        currentUrl = nextUrl
        continue
      }
      const text = await readBounded(response.body, options.maxResponseBytes)
      const result: GuardedFetchResult = {
        status: response.statusCode,
        headers: response.headers as Record<string, string>,
        body: text,
        json: tryJson(text),
      }
      return result
    }
    throw new BlockedUrlError('too many redirects')
  } finally {
    await agent.close()
  }
}

function readBounded(body: import('node:stream').Readable | null, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (body === null) { resolve(''); return }
    const chunks: Buffer[] = []
    let total = 0
    body.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new BlockedUrlError(`response exceeds ${maxBytes} bytes`))
        body.destroy()
        return
      }
      chunks.push(chunk)
    })
    body.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    body.on('error', reject)
  })
}

function tryJson(text: string): import('../../spec/types.ts').JsonValue {
  try {
    return JSON.parse(text) as import('../../spec/types.ts').JsonValue
  } catch {
    return null
  }
}

function isPublicIp(ip: string): boolean {
  const cleaned = ip.split('%')[0] ?? ''
  const family = net.isIP(cleaned)
  if (family === 4) return isPublicV4(cleaned)
  if (family === 6) return isPublicV6(cleaned)
  return false
}

function isPublicV4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  const [a, b, c] = parts
  if (a === undefined || b === undefined || c === undefined) return false
  if (a === 0) return false
  if (a === 10) return false
  if (a === 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a >= 224 && a <= 239) return false
  if (a >= 240) return false
  return true
}

function isPublicV6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1') return false
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return false
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7)
    return isPublicV4(v4)
  }
  return true
}

function createPinnedLookup(address: string): (hostname: string, options: object, callback: (err: Error | null, address: string | { address: string; family: number }[]) => void) => void {
  return (hostname, options, callback) => {
    const family = net.isIP(address) === 6 ? 6 : 4
    callback(null, address)
    void hostname
    void options
    void family
  }
}

function isAllowedHost(host: string, allowedHosts: string[]): boolean {
  for (const pattern of allowedHosts) {
    if (globMatch(host, pattern)) return true
  }
  return false
}

function globMatch(value: string, pattern: string): boolean {
  const regex = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${regex}$`).test(value)
}
