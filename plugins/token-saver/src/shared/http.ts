/**
 * Small helpers for Connection fetch routes: parse a buffered JSON body with a
 * size cap, and build JSON or plain-text error responses. Every route funnels
 * through these so validation and error formatting stay consistent.
 *
 * @module @dsh-plugins/token-saver/shared/http
 */

/** Default cap for a buffered POST body, in bytes. */
export const MAX_BODY_BYTES = 1_000_000

/**
 * Read and JSON-parse a route request body. Throws with a clear message when
 * the body is too large, is not valid JSON, or does not match the zod schema.
 * @param request - the incoming fetch request.
 * @param schema - a zod schema to validate the parsed value against.
 * @param cap - maximum accepted body size in bytes.
 * @returns the validated body value.
 */
export async function readJsonBody<T>(request: Request, schema: { parse(value: unknown): T }, cap = MAX_BODY_BYTES): Promise<T> {
  const contentLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(contentLength) && contentLength > cap) {
    throw new Error(`request body exceeds ${cap} bytes`)
  }
  let raw: string
  try {
    raw = await request.text()
  } catch {
    throw new Error('unable to read request body')
  }
  if (raw.length > cap) throw new Error(`request body exceeds ${cap} bytes`)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('request body is not valid JSON')
  }
  return schema.parse(value)
}

/** Build a JSON response with `cache-control: no-store`. */
export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('cache-control', 'no-store')
  return new Response(JSON.stringify(value), { ...init, headers })
}

/** Build a plain-text error response with the given status. */
export function textError(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'cache-control': 'no-store' } })
}

/** Translate an unknown error into a `{ message }` 500 or the given status. */
export function errorResponse(error: unknown, status = 500): Response {
  const message = error instanceof Error ? error.message : 'internal error'
  return textError(message, status)
}
