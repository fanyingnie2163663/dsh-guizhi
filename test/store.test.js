import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'

/** Temp data roots removed after the suite. */
const cleanup = []
after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true })
})

/**
 * A fresh store rooted at a throwaway home, as lib/index.js will create it
 * from $DSH_HOME/guizhi.
 * @returns {Promise<{ home: string, store: ReturnType<typeof createStore> }>}
 */
async function makeStore() {
  const home = await mkdtemp(join(tmpdir(), 'guizhi-store-'))
  cleanup.push(home)
  return { home, store: createStore({ home }) }
}

/** Directory entries that are atomic-write leftovers. @param {string} dir */
async function tempLeftovers(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return names.filter((name) => name.endsWith('.tmp'))
}

test('write 后 read 读回同一值，落盘是格式化 JSON', async () => {
  const { home, store } = await makeStore()
  const map = { scenarios: ['dev'], stages: [] }
  await store.write('map', map)
  const result = await store.read('map')
  assert.deepEqual(result, { value: map, error: null })
  const parsed = JSON.parse(await readFile(join(home, 'map.json'), 'utf8'))
  assert.deepEqual(parsed, map)
  assert.deepEqual(await tempLeftovers(home), [])
})

test('write 覆盖旧值；六个允许的 name 都能存（含 selections 与 F2 的 packs）', async () => {
  const { store } = await makeStore()
  for (const name of [
    'scan',
    'map',
    'proposals',
    'sources',
    'selections',
    'packs',
  ]) {
    await store.write(name, { name, round: 1 })
    assert.deepEqual(await store.read(name), { value: { name, round: 1 }, error: null })
    await store.write(name, { name, round: 2 })
    assert.deepEqual(await store.read(name), { value: { name, round: 2 }, error: null })
  }
})

test('read：文件不存在返回 { value:null, error:null }（首次扫描前不是错误）', async () => {
  const { store } = await makeStore()
  assert.deepEqual(await store.read('scan'), { value: null, error: null })
})

test('read：损坏 JSON 返回 { value:null, error } 而不抛，文件保持原样', async () => {
  const { home, store } = await makeStore()
  const broken = '{ this is not json'
  await writeFile(join(home, 'scan.json'), broken)
  const result = await store.read('scan')
  assert.equal(result.value, null)
  assert.equal(typeof result.error, 'string')
  assert.ok(result.error.length > 0)
  assert.match(result.error, /scan/)
  assert.match(result.error, /JSON|损坏/)
  assert.equal(await readFile(join(home, 'scan.json'), 'utf8'), broken)
})

test('name 白名单：拒绝单数 pack 与路径穿越，不落盘', async () => {
  const { home, store } = await makeStore()
  await assert.rejects(store.write('pack', {}), /状态名/)
  await assert.rejects(store.read('package'), /状态名/)
  await assert.rejects(store.write('../scan', {}), /状态名/)
  await assert.rejects(store.read('scan/../../etc'), /状态名/)
  assert.deepEqual(await tempLeftovers(home), [])
})

test('selections/packs：状态白名单新增 selections 与 packs，可存可读并进快照', async () => {
  const { home, store } = await makeStore()
  const selection = { selected: ['dev', 'research'], custom: '一句话场景' }
  const packs = { packs: [{ id: 'pack-1', version: 1 }] }
  await store.write('selections', selection)
  await store.write('packs', packs)
  assert.deepEqual(await store.read('selections'), { value: selection, error: null })
  assert.deepEqual(await store.read('packs'), { value: packs, error: null })
  const snapshot = await store.snapshot('with-selections')
  assert.deepEqual(snapshot.files, ['packs.json', 'selections.json'])
  const copied = JSON.parse(await readFile(join(home, 'snapshots', snapshot.id, 'selections.json'), 'utf8'))
  assert.deepEqual(copied, selection)
  assert.deepEqual(JSON.parse(await readFile(join(home, 'snapshots', snapshot.id, 'packs.json'), 'utf8')), packs)
})

test('write：不可序列化的值被拒绝并给出可读错误', async () => {
  const { store } = await makeStore()
  const circular = {}
  circular.self = circular
  await assert.rejects(store.write('scan', circular), /无法序列化/)
  await assert.rejects(store.write('scan', undefined), /无法序列化/)
  assert.deepEqual(await store.read('scan'), { value: null, error: null })
})

test('write：单文件 1MB 上限，超限拒绝且旧值不被破坏', async () => {
  const { home, store } = await makeStore()
  await store.write('scan', { keep: true })
  await assert.rejects(store.write('scan', { big: 'x'.repeat(1024 * 1024) }), /1MB|上限/)
  assert.deepEqual(await store.read('scan'), { value: { keep: true }, error: null })
  assert.deepEqual(await tempLeftovers(home), [])
})

test('snapshot：返回 id/tag/createdAt/files，并复制状态文件', async () => {
  const { home, store } = await makeStore()
  await store.write('scan', { step: 'scan' })
  await store.write('map', { step: 'map' })
  const snap = await store.snapshot('before-apply')
  assert.equal(typeof snap.id, 'string')
  assert.match(snap.id, /^[0-9A-Za-z][0-9A-Za-z-]+$/)
  assert.equal(snap.tag, 'before-apply')
  assert.equal(typeof snap.createdAt, 'string')
  assert.equal(Number.isNaN(Date.parse(snap.createdAt)), false)
  assert.deepEqual(snap.files, ['map.json', 'scan.json'])
  const copied = JSON.parse(await readFile(join(home, 'snapshots', snap.id, 'map.json'), 'utf8'))
  assert.deepEqual(copied, { step: 'map' })
})

test('snapshot：tag 省略时用 manual；没有状态文件也能拍快照', async () => {
  const { store } = await makeStore()
  const empty = await store.snapshot()
  assert.equal(empty.tag, 'manual')
  assert.deepEqual(empty.files, [])
  const restored = await store.restore(empty.id)
  assert.deepEqual(restored, { restored: true })
})

test('restore：快照后改动被恢复，返回 { restored:true }', async () => {
  const { store } = await makeStore()
  await store.write('map', { version: 1 })
  const snap = await store.snapshot('t')
  await store.write('map', { version: 2 })
  assert.deepEqual(await store.restore(snap.id), { restored: true })
  assert.deepEqual(await store.read('map'), { value: { version: 1 }, error: null })
  assert.deepEqual(await store.restore(snap.id), { restored: true })
  assert.deepEqual(await store.read('map'), { value: { version: 1 }, error: null })
})

test('restore：内容已一致时不重写（mtime 不变），且不动快照外的文件', async () => {
  const { home, store } = await makeStore()
  await store.write('map', { version: 1 })
  const snap = await store.snapshot('t')
  const before = (await stat(join(home, 'map.json'))).mtimeMs
  await store.restore(snap.id)
  await store.restore(snap.id)
  assert.equal((await stat(join(home, 'map.json'))).mtimeMs, before)
  await store.write('scan', { later: true })
  await store.restore(snap.id)
  assert.deepEqual(await store.read('scan'), { value: { later: true }, error: null })
})

test('restore：未知快照 id 抛出可读错误，不做写操作', async () => {
  const { store } = await makeStore()
  await assert.rejects(store.restore('snapshot-that-does-not-exist'), /快照/)
  await assert.rejects(store.restore('../etc'), /快照 id/)
  await assert.rejects(store.restore(''), /快照 id/)
})

test('restore：meta.json 合法 JSON 但形状错误 → 抛可读错误，不假成功也不写状态', async () => {
  const { home, store } = await makeStore()
  await store.write('map', { version: 1 })
  const snap = await store.snapshot('shape')
  await store.write('map', { version: 2 })
  const metaFile = join(home, 'snapshots', snap.id, 'meta.json')
  const broken = [
    { id: snap.id, tag: 'shape', createdAt: snap.createdAt, files: null },
    { id: snap.id, tag: 'shape', createdAt: snap.createdAt, files: 'map.json' },
    { id: snap.id, tag: 'shape', createdAt: snap.createdAt },
    { id: 42, tag: 'shape', createdAt: snap.createdAt, files: ['map.json'] },
    { id: 'other-snapshot', tag: 'shape', createdAt: snap.createdAt, files: ['map.json'] },
  ]
  for (const meta of broken) {
    await writeFile(metaFile, JSON.stringify(meta))
    await assert.rejects(store.restore(snap.id), /元数据已损坏/, JSON.stringify(meta))
  }
  await writeFile(metaFile, 'null')
  await assert.rejects(store.restore(snap.id), /元数据已损坏/)
  assert.deepEqual(await store.read('map'), { value: { version: 2 }, error: null })
  assert.deepEqual(await tempLeftovers(home), [])
})

test('listSnapshots：只返回 id/tag/createdAt，最新在前', async () => {
  const { store } = await makeStore()
  const first = await store.snapshot('first')
  const second = await store.snapshot('second')
  const rows = await store.listSnapshots()
  assert.equal(rows.length, 2)
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'createdAt',
    'id',
    'tag',
  ])
  assert.equal(rows[0].id, second.id)
  assert.equal(rows[1].id, first.id)
  assert.equal(rows[0].tag, 'second')
})

test('listSnapshots：跳过损坏的 snapshot 目录', async () => {
  const { home, store } = await makeStore()
  const bogus = join(home, 'snapshots', 'bogus')
  await mkdir(bogus, { recursive: true })
  await writeFile(join(bogus, 'meta.json'), 'not json')
  assert.deepEqual(await store.listSnapshots(), [])
})

test('createStore 参数校验：home 必须是非空字符串', () => {
  assert.throws(() => createStore({}), TypeError)
  assert.throws(() => createStore(), TypeError)
  assert.throws(() => createStore({ home: 42 }), TypeError)
  const store = createStore({ home: join(tmpdir(), 'guizhi-relative-home') + '-unused' })
  assert.equal(typeof store.read, 'function')
  assert.equal(typeof store.write, 'function')
  assert.equal(typeof store.snapshot, 'function')
  assert.equal(typeof store.restore, 'function')
  assert.equal(typeof store.listSnapshots, 'function')
})
