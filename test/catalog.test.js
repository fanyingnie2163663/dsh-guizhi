import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schemas } from '../lib/schemas.js'
import { CatalogFormatError, loadCatalog, matchGaps, parseFormat1 } from '../lib/catalog.js'

/**
 * 目录适配与缺口分析（Task 5）。全部测试注入 fetchImpl + mkdtemp cacheDir +
 * 固定 now，不联网；fixture 是公共目录 format-1 索引样例（test/fixtures/index.json）。
 */

const cleanup = []
after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true })
})

const URL_INDEX = 'https://catalog.example.invalid/format-1/index.json'
const NOW = 1_760_000_000_000

const FIXTURE = JSON.parse(await readFile(new URL('./fixtures/index.json', import.meta.url), 'utf8'))

/** 一个新的临时 cacheDir（目录本身故意不存在，验证 loadCatalog 会创建）。 */
async function makeCacheDir() {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-catalog-'))
  cleanup.push(home)
  return join(home, 'cache')
}

/** 缓存文件名契约：index-<sha256(url) 前 16 hex>.json。 */
function cacheFileFor(cacheDir, url) {
  return join(cacheDir, 'index-' + createHash('sha256').update(url).digest('hex').slice(0, 16) + '.json')
}

/** 列目录，目录不存在视为空。 */
async function listDir(dir) {
  try {
    return await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/** 记录调用次数的 fetch 桩；payload 为返回的 JSON。 */
function countingFetch(payload) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    return { ok: true, status: 200, json: async () => payload }
  }
  impl.calls = calls
  return impl
}

/** 一个合法的 D7 map：missing / have / redundant 三种能力都有。 */
function makeMap() {
  return {
    scenarios: ['dev'],
    stages: [
      {
        id: 'understand',
        title: '理解需求',
        capabilities: [
          { id: 'web-search', title: '联网搜索', status: 'missing', evidence: { source: 'catalog' } },
          { id: 'browser', title: '浏览器自动化', status: 'missing', evidence: { source: 'catalog' } },
          { id: 'installed-already', title: '已安装的插件', status: 'missing', evidence: { source: 'catalog' } },
          { id: 'web-search-have', title: '联网搜索已具备', status: 'have', evidence: { source: 'scan' } },
        ],
        tools: ['read'],
        skills: [],
      },
      {
        id: 'deliver',
        title: '交付文档',
        capabilities: [
          { id: 'docx', title: 'Word 文档', status: 'missing', evidence: { source: 'catalog' } },
          { id: 'redundant-cap', title: '冗余能力', status: 'redundant', evidence: { source: 'scan' } },
        ],
      },
    ],
  }
}

/** 一个合法的 D7 scan：已安装 dsh-installed-already（缺口分析必须排除它）。 */
function makeScan() {
  return {
    plugins: [{ name: 'dsh-installed-already', source: 'npm' }],
    tools: [],
    skills: [],
    totals: { plugins: 1, tools: 0, skills: 0, unusedTools: 0 },
    warnings: [],
    generatedAt: '2026-11-26T00:00:00.000Z',
  }
}

test('parseFormat1：合法夹具解析出条目（可选字段原样保留、未知顶层字段忽略）', () => {
  const catalog = parseFormat1(FIXTURE)
  assert.equal(catalog.entries.length, 4)
  assert.deepEqual(catalog.entries[0], {
    name: 'dsh-web-search',
    title: '联网搜索',
    description: '为 agent 提供联网搜索与网页抓取能力。',
    version: '1.2.0',
  })
  assert.equal(catalog.entries[2].name, 'dsh-office-docx')
  assert.equal(Object.hasOwn(catalog.entries[2], 'version'), false)
  assert.equal(catalog.entries[3].name, 'dsh-installed-already')
})

test('parseFormat1：形状不符抛 CatalogFormatError（不静默返回空）', () => {
  const badShapes = [
    null,
    [],
    '{"plugins": []}',
    {},
    { plugins: 'x' },
    { plugins: {} },
    { plugins: [null] },
    { plugins: [{}] },
    { plugins: [{ name: '' }] },
    { plugins: [{ name: '   ' }] },
    { plugins: [{ name: 'ok', title: 7 }] },
    { plugins: [{ name: 'ok', description: null }] },
    { plugins: [{ name: 'ok', version: 2 }] },
  ]
  for (const shape of badShapes) {
    assert.throws(
      () => parseFormat1(shape),
      (error) => {
        assert.ok(error instanceof CatalogFormatError, '应为 CatalogFormatError：' + JSON.stringify(shape))
        assert.equal(error.name, 'CatalogFormatError')
        assert.match(error.message, /目录格式不符/)
        assert.ok(Array.isArray(error.errors) && error.errors.length > 0)
        return true
      },
    )
  }
})

test('loadCatalog：首次请求成功 → 返回条目、写缓存、无 .tmp 残留', async () => {
  const cacheDir = await makeCacheDir()
  const fetchImpl = countingFetch(FIXTURE)
  const result = await loadCatalog({ url: URL_INDEX, cacheDir, now: NOW, fetchImpl })

  assert.deepEqual(result, { entries: parseFormat1(FIXTURE).entries, stale: false, error: null })
  assert.deepEqual(fetchImpl.calls, [URL_INDEX])
  assert.deepEqual(await listDir(cacheDir), [cacheFileFor(cacheDir, URL_INDEX).split(/[\\/]/).pop()])
  const cached = JSON.parse(await readFile(cacheFileFor(cacheDir, URL_INDEX), 'utf8'))
  assert.equal(cached.cachedAt, NOW)
  assert.deepEqual(cached.entries, parseFormat1(FIXTURE).entries)
  assert.deepEqual((await listDir(cacheDir)).filter((name) => name.endsWith('.tmp')), [])
})

test('loadCatalog：缓存新鲜时二次调用不请求（默认 ttlMs = 21600000）', async () => {
  const cacheDir = await makeCacheDir()
  const first = countingFetch(FIXTURE)
  const initial = await loadCatalog({ url: URL_INDEX, cacheDir, now: NOW, fetchImpl: first })
  assert.deepEqual(first.calls, [URL_INDEX])

  const second = countingFetch(FIXTURE)
  const cached = await loadCatalog({
    url: URL_INDEX,
    cacheDir,
    now: NOW + 21_600_000 - 1,
    fetchImpl: async () => {
      second.calls.push('should-not-be-called')
      throw new Error('缓存命中时不应发请求')
    },
  })
  assert.deepEqual(cached, { entries: initial.entries, stale: false, error: null })
  assert.deepEqual(second.calls, [])

  const afterTtl = countingFetch(FIXTURE)
  await loadCatalog({ url: URL_INDEX, cacheDir, now: NOW + 21_600_000, fetchImpl: afterTtl })
  assert.deepEqual(afterTtl.calls, [URL_INDEX], 'ttl 到期必须重新请求')
})

test('loadCatalog：fetch 抛错且无缓存 → 空条目 + error，不抛', async () => {
  const cacheDir = await makeCacheDir()
  const result = await loadCatalog({
    url: URL_INDEX,
    cacheDir,
    now: NOW,
    fetchImpl: async () => {
      throw new Error('网络不可达')
    },
  })
  assert.deepEqual(result.entries, [])
  assert.equal(result.stale, false)
  assert.match(result.error, /网络不可达/)
  assert.deepEqual(await listDir(cacheDir), [])
})

test('loadCatalog：过期缓存 + fetch 失败 → stale:true + 缓存条目 + 可读 error', async () => {
  const cacheDir = await makeCacheDir()
  await loadCatalog({ url: URL_INDEX, cacheDir, now: NOW, fetchImpl: countingFetch(FIXTURE) })
  const result = await loadCatalog({
    url: URL_INDEX,
    cacheDir,
    now: NOW + 21_600_001,
    fetchImpl: async () => {
      throw new Error('目录源离线')
    },
  })
  assert.equal(result.stale, true)
  assert.deepEqual(result.entries, parseFormat1(FIXTURE).entries)
  assert.match(result.error, /离线/)
})

test('loadCatalog：过期缓存 + fetch 成功 → 新条目、stale:false、缓存刷新', async () => {
  const cacheDir = await makeCacheDir()
  await loadCatalog({ url: URL_INDEX, cacheDir, now: NOW, fetchImpl: countingFetch(FIXTURE) })
  const next = { plugins: [{ name: 'dsh-fresh-plugin', title: '新插件' }] }
  const refreshed = await loadCatalog({
    url: URL_INDEX,
    cacheDir,
    now: NOW + 21_600_001,
    fetchImpl: countingFetch(next),
  })
  assert.deepEqual(refreshed, { entries: [{ name: 'dsh-fresh-plugin', title: '新插件' }], stale: false, error: null })
  const cached = JSON.parse(await readFile(cacheFileFor(cacheDir, URL_INDEX), 'utf8'))
  assert.equal(cached.cachedAt, NOW + 21_600_001)
  assert.deepEqual(cached.entries, [{ name: 'dsh-fresh-plugin', title: '新插件' }])
})

test('loadCatalog：非 2xx 与 JSON 解析失败都 fail-open 带明确 error', async () => {
  const cacheDir = await makeCacheDir()
  const httpError = await loadCatalog({
    url: URL_INDEX,
    cacheDir,
    now: NOW,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  })
  assert.deepEqual(httpError.entries, [])
  assert.match(httpError.error, /503/)

  const jsonError = await loadCatalog({
    url: URL_INDEX,
    cacheDir,
    now: NOW,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token')
      },
    }),
  })
  assert.deepEqual(jsonError.entries, [])
  assert.match(jsonError.error, /JSON/)
})

test('loadCatalog：目录格式错误 → 空条目 + 格式错误（不得伪装成没有缺口）', async () => {
  const cacheDir = await makeCacheDir()
  const result = await loadCatalog({
    url: URL_INDEX,
    cacheDir,
    now: NOW,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ plugins: 'x' }) }),
  })
  assert.deepEqual(result.entries, [])
  assert.equal(result.stale, false)
  assert.match(result.error, /格式/)
})

test('loadCatalog：坏 JSON 缓存与坏形状缓存都当作缓存缺失（重新请求）', async () => {
  const cacheDir = await makeCacheDir()
  await mkdir(cacheDir, { recursive: true })
  const file = cacheFileFor(cacheDir, URL_INDEX)
  await writeFile(file, '{not json', 'utf8')
  const brokenJson = countingFetch(FIXTURE)
  const fromBroken = await loadCatalog({ url: URL_INDEX, cacheDir, now: NOW, fetchImpl: brokenJson })
  assert.deepEqual(brokenJson.calls, [URL_INDEX])
  assert.deepEqual(fromBroken, { entries: parseFormat1(FIXTURE).entries, stale: false, error: null })
  assert.deepEqual((await listDir(cacheDir)).filter((name) => name.endsWith('.tmp')), [])

  const cacheDir2 = await makeCacheDir()
  await mkdir(cacheDir2, { recursive: true })
  const file2 = cacheFileFor(cacheDir2, URL_INDEX)
  await writeFile(file2, JSON.stringify({ cachedAt: NOW, entries: [{ name: '' }] }), 'utf8')
  const badShape = countingFetch(FIXTURE)
  const fromBadShape = await loadCatalog({ url: URL_INDEX, cacheDir: cacheDir2, now: NOW, fetchImpl: badShape })
  assert.deepEqual(badShape.calls, [URL_INDEX])
  assert.deepEqual(fromBadShape.entries, parseFormat1(FIXTURE).entries)
})

test('loadCatalog：超时 fail-open（注入永不返回的 fetchImpl）', async () => {
  const cacheDir = await makeCacheDir()
  const result = await loadCatalog({
    url: URL_INDEX,
    cacheDir,
    now: NOW,
    timeoutMs: 25,
    fetchImpl: () => new Promise(() => {}),
  })
  assert.deepEqual(result.entries, [])
  assert.match(result.error, /超时/)
})

test('matchGaps：只为 missing 能力生成，fixture 命中三条且不含已安装插件', () => {
  const catalog = parseFormat1(FIXTURE)
  assert.deepEqual(schemas.map.validate(makeMap()), { ok: true, errors: [] }, 'map fixture 必须是合法 D7 文档')
  assert.deepEqual(schemas.scan.validate(makeScan()), { ok: true, errors: [] }, 'scan fixture 必须是合法 D7 文档')
  const gaps = matchGaps({ scan: makeScan(), map: makeMap(), catalog })

  assert.equal(gaps.length, 3)
  assert.deepEqual(
    gaps.map((gap) => gap.evidence.refs[0]),
    ['dsh-web-search', 'dsh-browser-automation', 'dsh-office-docx'],
  )
  for (const gap of gaps) {
    assert.equal(gap.kind, 'install')
    assert.equal(gap.evidence.source, 'catalog')
    assert.equal(gap.evidence.refs.length, 1)
    assert.match(gap.id, /^gap-/)
    assert.match(gap.title, /dsh-/)
    assert.match(gap.effect, /安装/)
  }
  const joined = JSON.stringify(gaps)
  assert.equal(joined.includes('已安装的插件'), false, '已安装插件必须排除')
  assert.equal(joined.includes('联网搜索已具备'), false, 'have 能力不得生成提案')
  assert.equal(joined.includes('冗余能力'), false, 'redundant 能力不得生成提案')
  assert.equal(joined.includes('dsh-installed-already'), false, '已装插件名不得出现在提案中')
})

test('matchGaps：标题/描述/名称都能做不区分大小写的包含匹配', () => {
  const catalog = {
    entries: [
      { name: 'dsh-FOO', title: '无关标题' },
      { name: 'x-bar', title: '无关标题', description: '提供 WEB SEARCH 能力' },
    ],
  }
  const map = { scenarios: [], stages: [{ id: 's', title: '阶段', capabilities: [
    { id: 'bar', title: 'BAR 能力', status: 'missing', evidence: {} },
    { id: 'web', title: '随便', status: 'missing', evidence: {} },
  ] }] }
  const gaps = matchGaps({ scan: { plugins: [] }, map, catalog })
  assert.deepEqual(gaps.map((gap) => gap.evidence.refs[0]), ['x-bar', 'x-bar'])
})

test('matchGaps：catalog.entries 为空或缺失 → []（error 由调用方透传，不编造）', () => {
  assert.deepEqual(matchGaps({ scan: makeScan(), map: makeMap(), catalog: { entries: [] } }), [])
  assert.deepEqual(matchGaps({ scan: makeScan(), map: makeMap(), catalog: {} }), [])
  assert.deepEqual(matchGaps({ scan: makeScan(), map: makeMap(), catalog: undefined }), [])
  assert.deepEqual(matchGaps({ scan: makeScan(), map: undefined, catalog: parseFormat1(FIXTURE) }), [])
})

test('matchGaps：输出逐项通过 schemas.proposals 校验', () => {
  const gaps = matchGaps({ scan: makeScan(), map: makeMap(), catalog: parseFormat1(FIXTURE) })
  const doc = { items: gaps, generatedAt: '2026-11-26T00:00:00.000Z' }
  assert.deepEqual(schemas.proposals.validate(doc), { ok: true, errors: [] })
})

test('matchGaps：最多 20 条，截断但 id 稳定可复现', () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({
    name: 'dsh-plugin-' + String(index).padStart(3, '0'),
    title: '插件' + index,
    description: '支持 plug 能力',
  }))
  const map = { scenarios: [], stages: [{ id: 's', title: '阶段', capabilities: [
    { id: 'plug', title: '插件', status: 'missing', evidence: {} },
  ] }] }
  const scan = { plugins: [] }
  const first = matchGaps({ scan, map, catalog: { entries } })
  const second = matchGaps({ scan, map, catalog: { entries } })
  assert.equal(first.length, 20)
  assert.equal(new Set(first.map((gap) => gap.id)).size, 20)
  assert.deepEqual(first, second)
})

test('matchGaps：超长名称的 id 截断且保持稳定', () => {
  const longName = 'x'.repeat(300)
  const catalog = { entries: [{ name: longName, title: '超长名插件' }] }
  const map = { scenarios: [], stages: [{ id: 's', title: '阶段', capabilities: [
    { id: 'x', title: 'X', status: 'missing', evidence: {} },
  ] }] }
  const first = matchGaps({ scan: { plugins: [] }, map, catalog })
  const second = matchGaps({ scan: { plugins: [] }, map, catalog })
  assert.equal(first.length, 1)
  assert.ok(first[0].id.length <= 80, 'id 应截断到 80 字符以内：' + first[0].id.length)
  assert.deepEqual(first, second)
})

test('matchGaps：不修改输入的 scan / map / catalog', () => {
  const scan = makeScan()
  const map = makeMap()
  const catalog = parseFormat1(FIXTURE)
  const before = JSON.stringify({ scan, map, catalog })
  matchGaps({ scan, map, catalog })
  assert.equal(JSON.stringify({ scan, map, catalog }), before)
})
