/**
 * http executor: a guarded HTTP request. URLs, headers, query, and body are
 * rendered as templates; the request goes through `services.fetch` (SSRF
 * guarded). Non-2xx is not a failure — it is handed to a condition node.
 *
 * @module @dsh-plugins/flow/host/executors/http
 */

import type { FlowNode } from '../../spec/types.ts'
import { renderTemplate } from '../../spec/template.ts'
import { NodeError } from '../engine/budget.ts'
import type { ExecResult, NodeExecutor } from './index.ts'
import { BlockedUrlError } from '../services/guarded-fetch.ts'

type HttpNode = Extract<FlowNode, { type: 'http' }>

/** The http executor. */
export const httpExecutor: NodeExecutor<HttpNode> = {
  type: 'http',
  requires: ['fetch'],
  async execute(node, inputs, ctx): Promise<ExecResult> {
    const fetchFn = ctx.services.fetch
    if (fetchFn === undefined) throw new NodeError('SERVICE_UNAVAILABLE', 'http node requires the guarded fetch service')
    const values = inputs
    const url = renderTemplate(node.data.url, values).text
    const headers: Record<string, string> = {}
    const warnings: string[] = []
    for (const header of node.data.headers) {
      validateHeaderName(header.name)
      const value = renderTemplate(header.value, values).text
      validateHeaderValue(value)
      if (isForbiddenHeader(header.name)) {
        warnings.push(`header "${header.name}" is managed by the HTTP client and was ignored`)
        continue
      }
      headers[header.name] = value
    }
    const setDefaultContentType = (value: string): void => {
      if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['content-type'] = value
    }
    const query = new URLSearchParams()
    for (const q of node.data.query) query.append(q.name, renderTemplate(q.value, values).text)
    const urlWithQuery = query.size > 0 ? `${url}${url.includes('?') ? '&' : '?'}${query.toString()}` : url

    const method = node.data.method
    let body: string | undefined
    if (node.data.body.kind === 'none') {
      body = undefined
    } else if (node.data.body.kind === 'text') {
      body = renderTemplate(node.data.body.template, values).text
    } else if (node.data.body.kind === 'json') {
      const rendered = renderTemplate(node.data.body.template, values).text
      try {
        JSON.parse(rendered)
      } catch {
        throw new NodeError('HTTP_BAD_BODY', 'json body is not valid JSON')
      }
      body = rendered
      setDefaultContentType('application/json')
    } else if (node.data.body.kind === 'form') {
      const form = new URLSearchParams()
      for (const field of node.data.body.fields) form.append(field.name, renderTemplate(field.value, values).text)
      body = form.toString()
      setDefaultContentType('application/x-www-form-urlencoded')
    }

    if ((method === 'GET' || method === 'HEAD') && body !== undefined) {
      throw new NodeError('HTTP_BAD_BODY', `${method} requests must not include a body`)
    }

    let request: Request
    try {
      request = new Request(urlWithQuery, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        signal: ctx.signal,
      })
    } catch (error: unknown) {
      throw new NodeError('HTTP_BAD_URL', `invalid request "${urlWithQuery.slice(0, 200)}": ${error instanceof Error ? error.message : String(error)}`)
    }
    const timeoutMs = Math.min(node.data.timeoutMs ?? ctx.limits.http.timeoutMs, ctx.limits.maxNodeTimeoutMs)
    try {
      const result = await fetchFn(request, { timeoutMs, maxResponseBytes: ctx.limits.http.maxResponseBytes })
      return {
        outputs: {
          status: result.status,
          headers: result.headers,
          body: result.body,
          json: result.json,
        },
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    } catch (error: unknown) {
      if (error instanceof BlockedUrlError) throw new NodeError('HTTP_BLOCKED', error.message, false)
      // Only idempotent methods retry: a non-idempotent request may already have reached the server.
      const idempotent = method === 'GET' || method === 'HEAD'
      throw new NodeError('HTTP_NETWORK', error instanceof Error ? error.message : String(error), idempotent)
    }
  },
}

function validateHeaderName(name: string): void {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new NodeError('HTTP_BAD_HEADER', `invalid header name "${name}"`)
}

function validateHeaderValue(value: string): void {
  if (/[\r\n]/.test(value)) throw new NodeError('HTTP_BAD_HEADER', 'header value must not contain CR/LF')
}

function isForbiddenHeader(name: string): boolean {
  return ['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade'].includes(name.toLowerCase())
}
