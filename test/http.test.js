import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BODY_LIMIT, JSON_HEADERS, createHttpHandler, isLoopbackRequest } from '../lib/http.js'

/**
 * F6: lib/http.js is the extracted panel HTTP wire adapter. These tests drive it
 * with fake node req/res only — no host, no server, no network, and no import of
 * @deepseek-ai/dsh-tools (D11).
 */

/** Fake node http request: an EventEmitter with method/url/socket. */
function createRequest({ method = 'GET', url = '/', remoteAddress = '127.0.0.1', body } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.socket = { remoteAddress }
  process.nextTick(() => {
    if (body !== undefined) {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
      // Two chunks: exercises the size accumulator, not just a single buffer.
      const half = Math.ceil(buffer.length / 2)
      if (buffer.length > 0) {
        request.emit('data', buffer.subarray(0, half))
        request.emit('data', buffer.subarray(half))
      }
    }
    request.emit('end')
  })
  return request
}

/** Fake node http response capturing status/headers/body. */
function createResponse() {
  return {
    writableEnded: false,
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode
      this.headers = headers
    },
    end(text) {
      this.writableEnded = true
      this.body = String(text ?? '')
    },
  }
}

/** Run one route through the adapter and return the captured response. */
async function invoke(ctx, route, requestOptions) {
  const definition = { method: 'POST', path: '/api/guizhi/test', handler: async () => ({ status: 200, json: { ok: true } }), ...route }
  const request = createRequest({ remoteAddress: '127.0.0.1', ...requestOptions })
  const response = createResponse()
  await createHttpHandler(ctx, definition)(request, response)
  return {
    response,
    json: response.body === '' ? null : JSON.parse(response.body),
  }
}

/** A ctx with no host services at all (loopback fence only). */
const plainCtx = { get: () => undefined }

test('BODY_LIMIT 是 256KB 上限，JSON_HEADERS 不可缓存/不泄露 referrer', () => {
  assert.equal(BODY_LIMIT, 256 * 1024)
  assert.equal(JSON_HEADERS['content-type'], 'application/json; charset=utf-8')
  assert.equal(JSON_HEADERS['cache-control'], 'no-store')
  assert.equal(JSON_HEADERS['referrer-policy'], 'no-referrer')
  assert.ok(Object.isFrozen(JSON_HEADERS))
})

test('200：正常 handler 结果写成 JSON，GET query 解析成 payload', async () => {
  let received = null
  const { response, json } = await invoke(plainCtx, {
    method: 'GET',
    handler: async (payload) => {
      received = payload
      return { status: 200, json: { ok: true, name: 'guizhi' } }
    },
  }, { method: 'GET', url: '/api/guizhi/state?a=1&b=two&b=three' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.headers, JSON_HEADERS)
  assert.deepEqual(json, { ok: true, name: 'guizhi' })
  assert.deepEqual(received, { a: '1', b: 'three' }, 'GET 用 URLSearchParams（同名取最后一条）')
})

test('200：POST JSON 对象解析后交给 handler；空 body 视为 {}', async () => {
  const seen = []
  const route = {
    handler: async (payload) => {
      seen.push(payload)
      return { status: 201, json: { echoed: payload } }
    },
  }
  const first = await invoke(plainCtx, route, { method: 'POST', body: '{"ids":["a"],"custom":"中文"}' })
  assert.deepEqual(first.json, { echoed: { ids: ['a'], custom: '中文' } })
  const second = await invoke(plainCtx, route, { method: 'POST', body: '   ' })
  assert.deepEqual(second.json, { echoed: {} })
  assert.equal(seen.length, 2)
})

test('403：连接围栏拒绝且请求不是 loopback 时返回 forbidden', async () => {
  const ctx = {
    get: (name) => (name === 'connection' ? { requestRejection: () => ({ status: 403 }) } : undefined),
  }
  const { response, json } = await invoke(ctx, { method: 'GET' }, { method: 'GET', remoteAddress: '10.0.0.7' })
  assert.equal(response.statusCode, 403)
  assert.match(json.error, /forbidden/)
})

test('200：连接围栏放行（requestRejection 返回 undefined）时非 loopback 也允许', async () => {
  const ctx = {
    get: (name) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
  }
  const { response } = await invoke(ctx, { method: 'GET' }, { method: 'GET', remoteAddress: '10.0.0.7' })
  assert.equal(response.statusCode, 200)
})

test('200：围栏抛错时不变成开放门——退回 loopback 检查', async () => {
  const ctx = {
    get: (name) =>
      name === 'connection'
        ? {
            requestRejection: () => {
              throw new Error('fence exploded')
            },
          }
        : undefined,
  }
  const loopback = await invoke(ctx, { method: 'GET' }, { method: 'GET' })
  assert.equal(loopback.response.statusCode, 200)
  const remote = await invoke(ctx, { method: 'GET' }, { method: 'GET', remoteAddress: '10.0.0.7' })
  assert.equal(remote.response.statusCode, 403)
})

test('403：没有围栏服务时非 loopback 请求被拒绝（路由绝不对外开放）', async () => {
  const { response, json } = await invoke(plainCtx, { method: 'GET' }, { method: 'GET', remoteAddress: '10.0.0.7' })
  assert.equal(response.statusCode, 403)
  assert.match(json.error, /loopback-only/)
})

test('405：方法不匹配返回 405，且不调用 handler', async () => {
  let called = 0
  const { response, json } = await invoke(plainCtx, {
    method: 'POST',
    handler: async () => {
      called += 1
      return { status: 200, json: {} }
    },
  }, { method: 'GET' })
  assert.equal(response.statusCode, 405)
  assert.match(json.error, /method not allowed: GET/)
  assert.equal(called, 0)
})

test('413：请求体超过 256KB 上限返回 413', async () => {
  let called = 0
  const { response, json } = await invoke(plainCtx, {
    handler: async () => {
      called += 1
      return { status: 200, json: {} }
    },
  }, { method: 'POST', body: Buffer.alloc(BODY_LIMIT + 1, 0x61) })
  assert.equal(response.statusCode, 413)
  assert.match(json.error, /256KB|上限|字节/)
  assert.equal(called, 0, '超限请求不得进入 handler')
})

test('400：坏 JSON 与非对象 body 都返回 400，且不调用 handler', async () => {
  let called = 0
  const route = {
    handler: async () => {
      called += 1
      return { status: 200, json: {} }
    },
  }
  const badJson = await invoke(plainCtx, route, { method: 'POST', body: '{"ids":' })
  assert.equal(badJson.response.statusCode, 400)
  assert.match(badJson.json.error, /JSON/)
  for (const body of ['[1,2]', '"text"', '42', 'null']) {
    const result = await invoke(plainCtx, route, { method: 'POST', body })
    assert.equal(result.response.statusCode, 400, body)
    assert.match(result.json.error, /对象/, body)
  }
  assert.equal(called, 0)
})

test('500：handler 抛错被兜底成 500 + 可读 error，不冒泡', async () => {
  const { response, json } = await invoke(plainCtx, {
    handler: async () => {
      throw new Error('handler exploded')
    },
  }, { method: 'POST', body: '{}' })
  assert.equal(response.statusCode, 500)
  assert.equal(json.error, 'handler exploded')
})

test('isLoopbackRequest：127.0.0.1 / ::1 / ::ffff:127.0.0.1 放行，其余拒绝', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: address } }), true, address)
  }
  for (const address of ['10.0.0.1', '127.0.0.2', '', undefined]) {
    assert.equal(isLoopbackRequest({ socket: { remoteAddress: address } }), false, String(address))
  }
})
