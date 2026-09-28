import { describe, expect, it, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGuardedFetch, BlockedUrlError } from '../src/host/services/guarded-fetch.ts'

function startServer(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({ port, close: () => new Promise<void>(r => server.close(() => r())) })
    })
  })
}

let server: { port: number; close: () => Promise<void> } | undefined

afterAll(async () => {
  if (server !== undefined) await server.close()
})

describe('guarded-fetch', () => {
  it('fetches a public-host request when allowPrivateNetwork is true', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    const fetch = createGuardedFetch({ timeoutMs: 2000, maxResponseBytes: 1024, allowPrivateNetwork: true, allowedHosts: [] })
    const result = await fetch(new Request(`http://127.0.0.1:${server.port}/`), { timeoutMs: 2000, maxResponseBytes: 1024 })
    expect(result.status).toBe(200)
    expect(result.json).toEqual({ ok: true })
  })

  it('rejects a private address when allowPrivateNetwork is false', async () => {
    const fetch = createGuardedFetch({ timeoutMs: 2000, maxResponseBytes: 1024, allowPrivateNetwork: false, allowedHosts: [] })
    await expect(fetch(new Request('http://127.0.0.1:12345/'), { timeoutMs: 2000, maxResponseBytes: 1024 })).rejects.toBeInstanceOf(BlockedUrlError)
  })

  it('allows a private host when it matches allowedHosts', async () => {
    server = await startServer((_req, res) => { res.end('ok') })
    const fetch = createGuardedFetch({ timeoutMs: 2000, maxResponseBytes: 1024, allowPrivateNetwork: false, allowedHosts: ['127.0.0.1'] })
    const result = await fetch(new Request(`http://127.0.0.1:${server.port}/`), { timeoutMs: 2000, maxResponseBytes: 1024 })
    expect(result.body).toBe('ok')
  })

  it('rejects unsupported protocols', async () => {
    const fetch = createGuardedFetch({ timeoutMs: 2000, maxResponseBytes: 1024, allowPrivateNetwork: true, allowedHosts: [] })
    await expect(fetch(new Request('file:///etc/passwd'), { timeoutMs: 2000, maxResponseBytes: 1024 })).rejects.toBeInstanceOf(BlockedUrlError)
  })

  it('enforces the response byte limit', async () => {
    server = await startServer((_req, res) => { res.end('x'.repeat(4096)) })
    const fetch = createGuardedFetch({ timeoutMs: 2000, maxResponseBytes: 1024, allowPrivateNetwork: true, allowedHosts: [] })
    await expect(fetch(new Request(`http://127.0.0.1:${server.port}/`), { timeoutMs: 2000, maxResponseBytes: 1024 })).rejects.toBeInstanceOf(BlockedUrlError)
  })

  it('rejects a redirect to a private address', async () => {
    server = await startServer((_req, res) => {
      res.writeHead(302, { location: 'http://10.0.0.1/secret' })
      res.end()
    })
    const fetch = createGuardedFetch({ timeoutMs: 2000, maxResponseBytes: 1024, allowPrivateNetwork: false, allowedHosts: ['127.0.0.1'] })
    await expect(fetch(new Request(`http://127.0.0.1:${server.port}/`), { timeoutMs: 2000, maxResponseBytes: 1024 })).rejects.toBeInstanceOf(BlockedUrlError)
  })
})
