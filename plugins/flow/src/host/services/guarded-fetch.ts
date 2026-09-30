/**
 * SSRF-guarded fetch for the http node. Resolves the host and rejects private /
 * loopback / link-local addresses, pins the resolved address in an undici Agent
 * (preventing DNS rebinding), and follows redirects with re-checks and per-hop
 * re-resolution. Address classification uses `ipaddr.js` so every non-unicast
 * range is treated as non-public.
 *
 * @module @dsh-plugins/flow/host/services/guarded-fetch
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { Agent, request as undiciRequest } from 'undici'
import type { LookupAddress, LookupOptions } from 'node:dns'

/** Configuration for the guarded fetch. */
export interface GuardedFetchConfig {
  timeoutMs: number
  maxResponseBytes: number
  maxRedirects?: number
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

/** A resolved public address. */
export interface PublicAddress {
  address: string
  family: 4 | 6
}

/** An injectable resolver for tests. */
export type AddressResolver = (hostname: string, signal: AbortSignal) => Promise<PublicAddress[]>

/** Whether an IP literal is a public (unicast) address. */
export function isPublicIpAddress(input: string): boolean {
  const stripped = stripIpv6Brackets(input)
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(stripped) as ipaddr.IPv4 | ipaddr.IPv6
  } catch {
    return false
  }
  if (parsed instanceof ipaddr.IPv4) return parsed.range() === 'unicast'
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === 'unicast'
  return parsed.range() === 'unicast'
}

function stripIpv6Brackets(input: string): string {
  if (input.startsWith('[') && input.endsWith(']')) return input.slice(1, -1)
  return input
}

/** The default resolver: IP literals are classified directly; hostnames resolve once, keeping only public addresses to pin. */
async function defaultResolver(hostname: string, _signal: AbortSignal): Promise<PublicAddress[]> {
  const host = stripIpv6Brackets(hostname)
  const literal = isIP(host)
  if (literal !== 0) return isPublicIpAddress(host) ? [{ address: host, family: literal === 6 ? 6 : 4 }] : []
  const addresses = await dnsLookup(host, { all: true, order: 'verbatim' })
  return addresses.filter(entry => isPublicIpAddress(entry.address)).map(entry => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }))
}

/** Build a guarded fetch function. */
export function createGuardedFetch(config: GuardedFetchConfig, deps?: { resolver?: AddressResolver }): (request: Request, options: { timeoutMs: number; maxResponseBytes: number }) => Promise<GuardedFetchResult> {
  const resolver = deps?.resolver ?? defaultResolver
  return async (request, options) => {
    // One deadline covers every hop and the body read, so a slow-drip server cannot outlive it.
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(options.timeoutMs)])
    return await doFetch(new URL(request.url), request, { ...options, maxRedirects: config.maxRedirects ?? 5 }, config, resolver, signal)
  }
}

async function doFetch(url: URL, request: Request, options: { timeoutMs: number; maxResponseBytes: number; maxRedirects: number }, config: GuardedFetchConfig, resolver: AddressResolver, signal: AbortSignal): Promise<GuardedFetchResult> {
  let currentUrl = url
  let method = request.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'
  let body: string | undefined
  if (request.body !== null && request.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    body = await request.text()
  }
  let headers: Record<string, string> = {}
  request.headers.forEach((value, key) => { headers[key] = value })

  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
      throw new BlockedUrlError(`unsupported protocol ${currentUrl.protocol}`)
    }
    const host = currentUrl.hostname
    const allowed = config.allowPrivateNetwork || isAllowedHost(host, config.allowedHosts)
    let addresses: PublicAddress[] | undefined
    if (!allowed) {
      addresses = await resolver(host, signal)
      if (addresses.length === 0) throw new BlockedUrlError(`no public addresses for ${host}`)
    }
    // A fresh Agent per hop with a pinned lookup, so DNS rebinding cannot swap
    // the resolved address after validation.
    const agent = new Agent({
      autoSelectFamily: true,
      ...(addresses === undefined ? {} : { connect: { lookup: createPinnedLookup(addresses) } }),
    })
    let response: import('undici').Dispatcher.ResponseData
    try {
      response = await undiciRequest(currentUrl, {
        method,
        headers,
        body,
        maxRedirections: 0,
        headersTimeout: options.timeoutMs,
        bodyTimeout: options.timeoutMs,
        signal,
        dispatcher: agent,
      })
    } catch (error: unknown) {
      await agent.close()
      throw error
    }

    const location = response.headers['location']
    if (response.statusCode >= 300 && response.statusCode < 400 && location !== undefined) {
      const nextUrl = new URL(location, currentUrl)
      // 303, or 301/302 with a non-GET/HEAD method, becomes GET and drops body.
      if (response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && method !== 'GET' && method !== 'HEAD')) {
        method = 'GET'
        body = undefined
        delete headers['content-type']
        delete headers['content-length']
      }
      // Cross-origin redirect must drop credentials.
      if (nextUrl.origin !== currentUrl.origin) {
        delete headers['authorization']
        delete headers['cookie']
        delete headers['proxy-authorization']
      }
      // Consume the redirect body before following.
      try {
        await response.body.dump()
      } catch {
        // Best effort.
      }
      await agent.close()
      currentUrl = nextUrl
      continue
    }

    try {
      const text = await readBounded(response.body, options.maxResponseBytes, signal)
      const result: GuardedFetchResult = {
        status: response.statusCode,
        headers: joinHeaders(response.headers),
        body: text,
        json: tryJson(text),
      }
      return result
    } finally {
      await agent.close()
    }
  }
  throw new BlockedUrlError('too many redirects')
}

function joinHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    out[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

function readBounded(body: import('node:stream').Readable | null, maxBytes: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (body === null) { resolve(''); return }
    const chunks: Buffer[] = []
    let total = 0
    const onAbort = (): void => {
      body.destroy()
      reject(signal.reason ?? new Error('request aborted'))
    }
    const done = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    body.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        done()
        body.destroy()
        reject(new BlockedUrlError(`response exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    body.on('end', () => { done(); resolve(Buffer.concat(chunks).toString('utf8')) })
    body.on('error', (error: Error) => { done(); reject(error) })
  })
}

function tryJson(text: string): import('../../spec/types.ts').JsonValue {
  try {
    return JSON.parse(text) as import('../../spec/types.ts').JsonValue
  } catch {
    return null
  }
}

/**
 * A pinned lookup that serves pre-validated addresses. Handles both `all` and
 * `family` options, matching Node's `lookup` contract so undici never re-resolves.
 */
function createPinnedLookup(addresses: readonly PublicAddress[]) {
  return (hostname: string, options: LookupOptions, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void): void => {
    const family = typeof options.family === 'number' ? options.family
      : options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : 0
    const eligible = family === 0 ? addresses : addresses.filter(a => a.family === family)
    if (eligible.length === 0) {
      callback(Object.assign(new Error(`no validated address for ${hostname}`), { code: 'ENOTFOUND' }), options.all === true ? [] : '', family)
      return
    }
    if (options.all === true) {
      callback(null, eligible.map(a => ({ ...a })))
      return
    }
    const first = eligible[0] as PublicAddress
    callback(null, first.address, first.family)
  }
}

function isAllowedHost(host: string, allowedHosts: string[]): boolean {
  const normalized = host.toLowerCase()
  for (const pattern of allowedHosts) {
    if (globMatch(normalized, pattern.toLowerCase())) return true
  }
  return false
}

/**
 * Match a lowercase host against an `allowedHosts` pattern; `*` matches within one DNS label.
 * @param value - lowercase host.
 * @param pattern - lowercase pattern.
 * @returns whether the host matches.
 */
export function globMatch(value: string, pattern: string): boolean {
  const regex = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    // `*` matches within one DNS label, as documented; it never crosses a dot.
    .join('[^.]*')
  return new RegExp(`^${regex}$`).test(value)
}
