/**
 * Tests for the scan aggregator (task 2, Steps 4-5).
 *
 * Every produced scan is validated with schemas.scan (the D7 shape authority);
 * the fake host lives in test/fixtures/host.js and is fully self-contained.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { schemas } from '../lib/schemas.js'
import { scanFacts } from '../lib/scan.js'
import { summarizeUsage } from '../lib/usage.js'
import { createFakeHost, OWNERLESS_TOOL_ROWS, PLUGIN_ROWS, SKILL_ROWS } from './fixtures/host.js'

/** Fixed scan time: generatedAt must be exactly this ISO string. */
const NOW = new Date('2026-11-26T08:00:00.000Z')
const ISO = '2026-11-26T08:00:00.000Z'
const USAGE_ISO = '2026-11-21T10:00:00.000Z'

/** A known usage summary shaped like summarizeUsage's result. */
function knownUsage(entries = []) {
  return { byTool: new Map(entries), unknown: false }
}

/** Assert the D7 contract: scanFacts output always passes schemas.scan. */
function validScan(scan) {
  const result = schemas.scan.validate(scan)
  assert.deepEqual(result, { ok: true, errors: [] }, 'scan 必须通过 schemas.scan.validate：' + JSON.stringify(result.errors))
}

/** @param {object} scan @param {string} name */
function byName(scan, name) {
  const row = scan.tools.find((tool) => tool.name === name)
  assert.ok(row !== undefined, '缺少工具 ' + name)
  return row
}

test('scanFacts 汇总 plugins/tools/skills，并用 usage 填 used30d 与 lastUsedAt', async () => {
  const host = createFakeHost()
  const usage = knownUsage([
    ['read', { count: 2, lastUsedAt: USAGE_ISO }],
    ['stow_scan', { count: 1, lastUsedAt: ISO }],
  ])
  const scan = await scanFacts({ host, usage, now: NOW })
  validScan(scan)

  assert.equal(scan.generatedAt, ISO)
  assert.deepEqual(scan.warnings, [])
  assert.deepEqual(scan.plugins, PLUGIN_ROWS)
  assert.deepEqual(scan.skills, SKILL_ROWS)
  assert.deepEqual(scan.tools.map((row) => row.name), ['read', 'write', 'stow_scan'])
  assert.deepEqual(byName(scan, 'read'), {
    name: 'read',
    description: 'Read a UTF-8 text file',
    owners: ['@deepseek-ai/dsh-tool-fs', 'dsh-better-sidebar'],
    used30d: 2,
    lastUsedAt: USAGE_ISO,
  })
  assert.deepEqual(byName(scan, 'write'), {
    name: 'write',
    description: 'Write a UTF-8 text file',
    owners: ['@deepseek-ai/dsh-tool-fs'],
    used30d: 0,
    lastUsedAt: null,
  })
  assert.deepEqual(scan.totals, { plugins: 3, tools: 3, skills: 2, unusedTools: 1 })
})

test('同名工具被多个插件注册：owners 去重并保留全部来源（Review Focus #4）', async () => {
  const host = createFakeHost({
    tools: [
      { name: 'read', description: 'first description', owner: 'plugin-a' },
      { name: 'read', description: 'second description', owner: 'plugin-b' },
      { name: 'read', description: 'third description', owner: 'plugin-a' },
    ],
  })
  const scan = await scanFacts({ host, usage: knownUsage(), now: NOW })
  validScan(scan)
  assert.equal(scan.tools.length, 1, '同名工具必须合并成一行')
  assert.deepEqual(scan.tools[0], {
    name: 'read',
    description: 'first description',
    owners: ['plugin-a', 'plugin-b'],
    used30d: 0,
    lastUsedAt: null,
  })
})

test('usage.unknown 时 used30d/lastUsedAt 一律 null，绝不当成 0（Review Focus #2）', async () => {
  const host = createFakeHost()
  const usage = { byTool: new Map([['read', { count: 9, lastUsedAt: USAGE_ISO }]]), unknown: true }
  const scan = await scanFacts({ host, usage, now: NOW })
  validScan(scan)
  for (const row of scan.tools) {
    assert.equal(row.used30d, null, row.name + ' 的用量未知必须是 null')
    assert.equal(row.lastUsedAt, null, row.name + ' 的 lastUsedAt 未知必须是 null')
  }
  assert.equal(scan.totals.unusedTools, 0, '未知用量不是「已知 0 次」')
})

test('totals.unusedTools 只统计「已知用量为 0」的工具', async () => {
  const host = createFakeHost()
  const scan = await scanFacts({ host, usage: knownUsage([['read', { count: 4, lastUsedAt: USAGE_ISO }]]), now: NOW })
  validScan(scan)
  assert.equal(byName(scan, 'read').used30d, 4)
  assert.equal(byName(scan, 'read').lastUsedAt, USAGE_ISO)
  assert.deepEqual(
    scan.tools.filter((row) => row.used30d === 0).map((row) => row.name),
    ['write', 'stow_scan'],
  )
  assert.equal(scan.totals.unusedTools, 2)
})

test('全部工具行都没有 owner：owners:[] 且写一条 warning，不编造来源', async () => {
  const host = createFakeHost({ tools: OWNERLESS_TOOL_ROWS })
  const scan = await scanFacts({ host, usage: knownUsage(), now: NOW })
  validScan(scan)
  assert.deepEqual(scan.tools.map((row) => row.owners), [[], []])
  const ownerWarnings = scan.warnings.filter((message) => message.includes('owner'))
  assert.equal(ownerWarnings.length, 1, '全部无 owner 时只写一条 warning：' + JSON.stringify(scan.warnings))
})

test('host.warnings 快照透传：patch 解析失败不得被吞掉（Review Focus #1）', async () => {
  const message = '读取 profile cordis.patch.yml 失败：YAMLException: bad indentation'
  const host = createFakeHost({ warnings: [message] })
  const scan = await scanFacts({ host, usage: knownUsage(), now: NOW })
  validScan(scan)
  assert.ok(scan.warnings.includes(message), JSON.stringify(scan.warnings))
  scan.warnings.push('调用方篡改')
  assert.deepEqual(host.warnings, [message], 'scan 不得改动宿主警告快照')
})

test('host 服务缺失或抛错：写 warning、不抛，scan 仍然合法', async () => {
  const broken = createFakeHost({
    fail: { tools: 'tools.view 失败：boom', plugins: 'profile 不可读', skills: 'skills.list 失败' },
  })
  const scan = await scanFacts({ host: broken, usage: knownUsage(), now: NOW })
  validScan(scan)
  assert.deepEqual(scan.tools, [])
  assert.deepEqual(scan.plugins, [])
  assert.deepEqual(scan.skills, [])
  assert.deepEqual(scan.totals, { plugins: 0, tools: 0, skills: 0, unusedTools: 0 })
  for (const method of ['listTools', 'listPlugins', 'listSkills']) {
    assert.ok(
      scan.warnings.some((message) => message.includes(method)),
      method + ' 失败必须留下 warning：' + JSON.stringify(scan.warnings),
    )
  }

  const empty = await scanFacts({ host: {}, usage: knownUsage(), now: NOW })
  validScan(empty)
  assert.ok(empty.warnings.length >= 3, '缺失的清单方法必须逐个告警：' + JSON.stringify(empty.warnings))
  assert.equal(empty.generatedAt, ISO)
})

test('list 方法返回非数组：按空清单处理并留下 warning', async () => {
  const host = createFakeHost({ tools: 'nope', plugins: null, skills: { list() {} } })
  const scan = await scanFacts({ host, usage: knownUsage(), now: NOW })
  validScan(scan)
  assert.deepEqual(scan.tools, [])
  assert.deepEqual(scan.plugins, [])
  assert.deepEqual(scan.skills, [])
  const malformed = scan.warnings.filter((message) => message.includes('返回结构异常'))
  assert.equal(malformed.length, 3, JSON.stringify(scan.warnings))
})

test('无效的清单行被跳过，并在 warnings 里说明原因', async () => {
  const host = createFakeHost({
    plugins: [{ name: 'ok-plugin', source: 'npm' }, { name: 'no-source' }, { name: '', source: 'npm' }, null, 42],
    tools: [{ name: 'read', description: 'Read', owner: 'plugin-a' }, { description: 'no name' }, null],
    skills: [{ name: 'brainstorming', source: 'user' }, { source: 'user' }, null],
  })
  const scan = await scanFacts({ host, usage: knownUsage(), now: NOW })
  validScan(scan)
  assert.deepEqual(scan.plugins, [{ name: 'ok-plugin', source: 'npm' }])
  assert.deepEqual(scan.tools.map((row) => row.name), ['read'])
  assert.deepEqual(scan.skills, [{ name: 'brainstorming', source: 'user' }])
  for (const method of ['listPlugins', 'listTools', 'listSkills']) {
    assert.ok(
      scan.warnings.some((message) => message.includes('无效行') && message.includes(method)),
      method + ' 的无效行必须留下 warning：' + JSON.stringify(scan.warnings),
    )
  }
})

test('可选字段缺失时省略而不是编造：plugin.version / skill.source', async () => {
  const host = createFakeHost({
    plugins: [{ name: 'dsh-better-sidebar', source: 'patch' }],
    tools: [{ name: 'read', description: 'Read', owner: 'plugin-a' }],
    skills: [{ name: 'writing-plans' }],
  })
  const scan = await scanFacts({ host, usage: knownUsage(), now: NOW })
  validScan(scan)
  assert.equal(Object.hasOwn(scan.plugins[0], 'version'), false)
  assert.equal(Object.hasOwn(scan.skills[0], 'source'), false)
})

test('usage 缺失或形状不对：按未知处理并告警，used30d 不是 0（D12）', async () => {
  const host = createFakeHost()
  for (const usage of [null, undefined, {}, { byTool: {}, unknown: false }]) {
    const scan = await scanFacts({ host, usage, now: NOW })
    validScan(scan)
    for (const row of scan.tools) {
      assert.equal(row.used30d, null)
      assert.equal(row.lastUsedAt, null)
    }
    assert.equal(scan.totals.unusedTools, 0)
    assert.ok(scan.warnings.some((message) => message.includes('usage')), JSON.stringify(scan.warnings))
  }
})

test('usage.byTool 里的坏条目：该工具记 null 而不是 0，并留下 warning', async () => {
  const host = createFakeHost()
  const scan = await scanFacts({ host, usage: knownUsage([['read', { count: -1, lastUsedAt: null }]]), now: NOW })
  validScan(scan)
  assert.equal(byName(scan, 'read').used30d, null)
  assert.equal(scan.totals.unusedTools, 2, 'read 是未知，不是已知 0 次')
  assert.ok(scan.warnings.some((message) => message.includes('read')), JSON.stringify(scan.warnings))
})

test('now 无效时 generatedAt 仍为合法 ISO 并写 warning，不抛', async () => {
  const scan = await scanFacts({ host: createFakeHost(), usage: knownUsage(), now: new Date('nope') })
  validScan(scan)
  assert.equal(typeof scan.generatedAt, 'string')
  assert.equal(Number.isNaN(Date.parse(scan.generatedAt)), false)
  assert.ok(scan.warnings.some((message) => message.includes('generatedAt')), JSON.stringify(scan.warnings))
})

test('summarizeUsage 的结果可直接作为 usage 喂给 scanFacts（契约咬合）', async () => {
  const text = await readFile(new URL('./fixtures/events.txt', import.meta.url), 'utf8')
  const events = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // The fixture's broken JSON line is covered by the usage tests.
    }
  }
  const usage = await summarizeUsage({ events, now: NOW })
  const scan = await scanFacts({ host: createFakeHost(), usage, now: NOW })
  validScan(scan)
  assert.equal(byName(scan, 'read').used30d, 2)
  assert.equal(byName(scan, 'read').lastUsedAt, '2026-11-21T10:00:00.000Z')
  assert.equal(byName(scan, 'write').used30d, 1)
  assert.equal(byName(scan, 'stow_scan').used30d, 0, '窗口内无调用的工具是已知 0 次')
  assert.equal(scan.totals.unusedTools, 1)
})
