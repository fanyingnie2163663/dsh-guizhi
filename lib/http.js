/**
 * Guizhi panel HTTP wire adapter (fix wave F6).
 *
 * One node http handler per payload route: access fence, method check, request
 * body cap + JSON parse, then serialize {status, json}. Extracted from
 * lib/index.js so the wire behavior is unit-testable with fake req/res
 * (test/http.test.js) without importing @deepseek-ai/dsh-tools (D11 keeps that
 * import in lib/index.js only).
 *
 * The module imports no host SDK: createHttpHandler(ctx, route) only needs a
 * ctx whose optional `connection` service provides requestRejection(request).
 * A missing service degrades to the loopback fence, exactly like the plugin
 * mount did before the extraction.
 *
 * @module @fanyingnie/dsh-guizhi/http
 */
import { describeError, tryGet } from './host.js'

/** Largest request body accepted by a panel route (a pack/map document). */
export const BODY_LIMIT = 256 * 1024

/** JSON response headers: never cached, never referrer-leaking. */
export const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
})

/** @param {unknown} value */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fallback access fence for builds with no connection service: the panel is
 * served from the same origin, so loopback is the normal case.
 * @param {import('node:http').IncomingMessage} request
 */
export function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Resolve the optional host connection fence without requiring injection. */
function resolveConnection(ctx) {
  const candidate = tryGet(ctx, 'connection')
  return isObject(candidate) && typeof candidate.requestRejection === 'function' ? candidate : undefined
}

/**
 * Whether a request may enter a panel route: the harness connection fence when
 * available, otherwise the loopback check (never open the route to the network).
 * @param {*} ctx @param {import('node:http').IncomingMessage} request
 */
export function isRequestAllowed(ctx, request) {
  const connection = resolveConnection(ctx)
  if (connection !== undefined) {
    try {
      if (connection.requestRejection(request) === undefined) return true
    } catch {
      // A throwing fence must not turn into an open door; fall through.
    }
  }
  return isLoopbackRequest(request)
}

/** @param {import('node:http').IncomingMessage} request */
function requestUrl(request) {
  return new URL(request.url ?? '/', 'http://localhost')
}

/** Write one JSON response (no-op once the response already ended). */
export function writeJson(response, status, body) {
  if (response.writableEnded) return
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(body))
}

/**
 * Read a request body with a hard cap; writes 413/400 itself and resolves
 * undefined when it already answered.
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @returns {Promise<string | undefined>}
 */
export function readBody(request, response) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > BODY_LIMIT) {
        writeJson(response, 413, { error: '请求体超过 ' + BODY_LIMIT + ' 字节上限' })
        // Keep draining so the client can read the 413 before the socket resets.
        settle(undefined)
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => settle(Buffer.concat(chunks).toString('utf8')))
    request.on('error', () => {
      writeJson(response, 400, { error: '请求体读取失败' })
      settle(undefined)
    })
  })
}

/**
 * Parse one JSON object body; undefined means a response was already written.
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 */
export async function readJsonObject(request, response) {
  const raw = await readBody(request, response)
  if (raw === undefined) return undefined
  if (raw.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    writeJson(response, 400, { error: '请求体不是合法 JSON' })
    return undefined
  }
  if (!isObject(parsed)) {
    writeJson(response, 400, { error: '请求体必须是 JSON 对象' })
    return undefined
  }
  return parsed
}

/**
 * Adapt one payload handler to a node http handler: fence, method check, body
 * cap + JSON parse, then serialize {status, json}. All exceptions are caught.
 * @param {*} ctx @param {{ method: string, path: string, handler: Function }} route
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHttpHandler(ctx, route) {
  return async (request, response) => {
    try {
      if (!isRequestAllowed(ctx, request)) {
        writeJson(response, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (request.method !== route.method) {
        writeJson(response, 405, { error: 'method not allowed: ' + (request.method ?? '') })
        return
      }
      let payload
      if (route.method === 'GET') {
        payload = Object.fromEntries(requestUrl(request).searchParams.entries())
      } else {
        payload = await readJsonObject(request, response)
        if (payload === undefined) return
      }
      const result = await route.handler(payload)
      writeJson(response, result.status, result.json)
    } catch (error) {
      writeJson(response, 500, { error: describeError(error) })
    }
  }
}
