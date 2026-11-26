/**
 * Tests for the usage summarizer (task 2, Step 1).
 *
 * The fixture window is [2026-10-27T08:00:00.000Z, 2026-11-26T08:00:00.000Z]
 * (a 30-day window ending at NOW); events.txt pins every boundary case with a
 * fixed timestamp so the tests never depend on the machine clock.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { summarizeUsage } from '../lib/usage.js'

/** Fixed "now" so the 30-day window is deterministic. */
const NOW = new Date('2026-11-26T08:00:00.000Z')
const EVENTS_FILE = new URL('./fixtures/events.txt', import.meta.url)

/** Every non-empty JSONL line from the fixture, in file order. */
async function fixtureLines() {
  const text = await readFile(EVENTS_FILE, 'utf8')
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** Parse the valid lines; the fixture intentionally contains one broken line. */
async function fixtureEvents() {
  const events = []
  for (const line of await fixtureLines()) {
    try {
      events.push(JSON.parse(line))
    } catch {
      // Covered by the "broken line is skipped" test.
    }
  }
  return events
}

/** Compare a byTool Map as a plain object (Map key order is not the contract). */
function entries(byTool) {
  return Object.fromEntries(byTool)
}

const WINDOW_30D = {
  read: { count: 2, lastUsedAt: '2026-11-21T10:00:00.000Z' },
  write: { count: 1, lastUsedAt: '2026-11-25T09:30:00.000Z' },
  run_code: { count: 1, lastUsedAt: '2026-10-27T08:00:00.000Z' },
}

test('两行同工具事件聚合为计数，lastUsedAt 取窗口内最新时间', async () => {
  const result = await summarizeUsage({ events: await fixtureEvents(), now: NOW })
  assert.equal(result.unknown, false)
  assert.ok(result.byTool instanceof Map, 'byTool 必须是 Map')
  assert.deepEqual(entries(result.byTool), WINDOW_30D)
})

test('窗口外事件被排除：早于 30 天、cutoff 前 1ms、晚于 now 都不计', async () => {
  const result = await summarizeUsage({ events: await fixtureEvents(), now: NOW })
  for (const name of ['old_tool', 'just_outside', 'future_tool']) {
    assert.equal(result.byTool.has(name), false, name + ' 在窗口外，不得计入')
  }
  // The event exactly on the cutoff is inside the window; it is the only reason
  // run_code appears above, so the boundary is observable in both directions.
  assert.deepEqual(entries(result.byTool), WINDOW_30D)
})

test('events 为 null（或缺失）时 unknown:true 且 byTool 为空 Map', async () => {
  for (const events of [null, undefined]) {
    const result = await summarizeUsage({ events, now: NOW })
    assert.equal(result.unknown, true)
    assert.ok(result.byTool instanceof Map)
    assert.equal(result.byTool.size, 0)
  }
})

test('无法解析的行跳过不抛（含 fixture 里的坏 JSON 行）', async () => {
  const lines = await fixtureLines()
  const hasBrokenJSON = lines.some((line) => {
    try {
      JSON.parse(line)
      return false
    } catch {
      return true
    }
  })
  assert.ok(hasBrokenJSON, 'fixture 必须保留至少一行坏 JSON')

  // Raw JSONL lines and junk objects mixed together: valid rows still count,
  // every unreadable row is skipped, nothing throws.
  const result = await summarizeUsage({ events: lines, now: NOW })
  assert.equal(result.unknown, false)
  assert.deepEqual(entries(result.byTool), WINDOW_30D)

  const junk = await summarizeUsage({
    events: [null, 42, 'not json', {}, { tool: 'read' }, { tool: 'read', at: 'not-a-date' }],
    now: NOW,
  })
  assert.equal(junk.unknown, false)
  assert.equal(junk.byTool.size, 0)
})

test('同步 iterable 与异步 iterable 都可消费', async () => {
  const events = await fixtureEvents()
  const fromSet = await summarizeUsage({ events: new Set(events), now: NOW })
  async function* replay() {
    for (const event of events) yield event
  }
  const fromAsync = await summarizeUsage({ events: replay(), now: NOW })
  assert.deepEqual(entries(fromSet.byTool), WINDOW_30D)
  assert.deepEqual(entries(fromAsync.byTool), WINDOW_30D)
  assert.equal(fromAsync.unknown, false)
})

test('windowDays 可配置；非法 windowDays 回退 30 天', async () => {
  const events = await fixtureEvents()
  const day = await summarizeUsage({ events, now: NOW, windowDays: 1 })
  assert.equal(day.unknown, false)
  assert.deepEqual(entries(day.byTool), {
    write: { count: 1, lastUsedAt: '2026-11-25T09:30:00.000Z' },
  })

  const fallback = await summarizeUsage({ events, now: NOW, windowDays: Number.NaN })
  assert.deepEqual(entries(fallback.byTool), WINDOW_30D)
})

test('事件源中途抛错时 unknown:true 且不抛（不信任半截统计）', async () => {
  async function* broken() {
    yield { tool: 'read', at: '2026-11-20T10:00:00.000Z', sessionId: 's1' }
    throw new Error('日志读失败')
  }
  const result = await summarizeUsage({ events: broken(), now: NOW })
  assert.equal(result.unknown, true)
  assert.equal(result.byTool.size, 0)
})

test('now 无效时 unknown:true 且不抛（窗口无法计算，不能猜成 0）', async () => {
  const result = await summarizeUsage({ events: [], now: new Date('not-a-date') })
  assert.equal(result.unknown, true)
  assert.equal(result.byTool.size, 0)
})
