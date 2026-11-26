/**
 * Tests for static tool-owner attribution (T2.5, D8).
 *
 * Every fixture is a throwaway profile under mkdtemp: a fake profile root with
 * node_modules/<pkg>/package.json plus JS sources that register tool names via
 * the real plugin shapes (tools.register(defineTool({ name })) / register({ name })).
 * The tests pin the contract: same-name tools from two plugins become multiple
 * rows (scan merges owners), unmatched tools stay ownerless with one bounded
 * warning, and every read failure degrades to a warning instead of throwing.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { attributeTools, withAttribution } from '../lib/attribution.js'

/** Temp profile roots removed after the suite. */
const cleanup = []
after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true })
})

/** An empty throwaway profile directory with a node_modules sub-directory. */
async function makeProfile() {
  const root = await mkdtemp(join(tmpdir(), 'guizhi-attr-'))
  cleanup.push(root)
  await mkdir(join(root, 'node_modules'), { recursive: true })
  return root
}

/**
 * Install one fake plugin: files is a relative-path -> content map. The
 * package.json is added automatically unless the caller provides one.
 * @param {string} profilePath
 * @param {string} pkgName
 * @param {Record<string, string>} [files]
 * @returns {Promise<string>} the plugin root
 */
async function installPlugin(profilePath, pkgName, files = {}) {
  const root = join(profilePath, 'node_modules', ...pkgName.split('/'))
  const all = { 'package.json': JSON.stringify({ name: pkgName, version: '1.0.0' }), ...files }
  for (const [relative, text] of Object.entries(all)) {
    const file = join(root, ...relative.split('/'))
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, text)
  }
  return root
}

/** Tool rows sent in, mirroring host.listTools(). */
function tool(name, description = name + ' 工具') {
  return { name, description }
}

/** @param {object[]} rows @param {string} name */
function rowsNamed(rows, name) {
  return rows.filter((row) => row.name === name)
}

/** @param {object[]} rows @param {string} name */
function ownersOf(rows, name) {
  return rowsNamed(rows, name)
    .map((row) => (typeof row.owner === 'string' ? row.owner : ''))
    .filter((owner) => owner !== '')
}

test('同名工具来自两个 npm 插件：同名多行、每行一个 owner；未匹配工具 1 行无 owner + warning', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'plugin-a', {
    'lib/index.js': [
      "import { defineTool } from '@deepseek-ai/dsh-tools'",
      'ctx.tools.register(defineTool({ name: "shared_tool", description: "a" }))',
      "ctx.tools.register(defineTool({ name: 'tool_a', description: 'a only' }))",
    ].join('\n'),
  })
  await installPlugin(profilePath, 'plugin-b', {
    'lib/index.js': 'register({ name: "shared_tool", description: "b" })\n',
  })
  const tools = [tool('shared_tool', '共用工具'), tool('tool_a'), tool('orphan_tool')]
  const { rows, warnings } = await attributeTools({
    tools,
    plugins: [
      { name: 'plugin-a', version: '1.0.0', source: 'npm' },
      { name: 'plugin-b', source: 'npm' },
    ],
    profilePath,
  })

  const shared = rowsNamed(rows, 'shared_tool')
  assert.equal(shared.length, 2, '同名工具来自两个插件必须输出两行：' + JSON.stringify(rows))
  assert.deepEqual(shared.map((row) => row.owner), ['plugin-a', 'plugin-b'])
  for (const row of shared) assert.equal(row.description, '共用工具', '两行 description 必须与原行一致')
  assert.deepEqual(ownersOf(rows, 'tool_a'), ['plugin-a'])
  const orphan = rowsNamed(rows, 'orphan_tool')
  assert.equal(orphan.length, 1)
  assert.deepEqual(orphan[0], { name: 'orphan_tool', description: 'orphan_tool 工具' }, '未归属行不得带 owner 字段')
  assert.equal(Object.hasOwn(orphan[0], 'owner'), false)
  assert.ok(rows.some((row) => row.name === 'shared_tool' && row.owner === 'plugin-b'), '必须保留第二个来源')

  const unattributed = warnings.filter((message) => message.includes('无法归因'))
  assert.equal(unattributed.length, 1, '未归因工具汇总成一条 warning：' + JSON.stringify(warnings))
  assert.match(unattributed[0], /orphan_tool/)
  assert.equal(unattributed[0].includes('shared_tool'), false)
  assert.equal(unattributed[0].includes('tool_a'), false)
})

test('scoped 包名路径 + 三种真实注册形态都能归因', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, '@scope/pkg-x', {
    'lib/index.js': [
      'function reg(def) { return ctx.tools.register(def) }',
      'ctx.tools.register(defineTool({ name: "alpha_tool", description: "a" }))',
      'ctx.tools.register({ name: "beta_tool", description: "b" })',
      "reg(defineTool({ name: 'gamma_tool', description: 'c' }))",
      'ctx.tools.register(defineTool({ name: "delta_tool", get description() { return "d" } }))',
    ].join('\n'),
  })
  const { rows, warnings } = await attributeTools({
    tools: [tool('alpha_tool'), tool('beta_tool'), tool('gamma_tool'), tool('delta_tool')],
    plugins: [{ name: '@scope/pkg-x', version: '1.0.0', source: 'npm' }],
    profilePath,
  })
  for (const name of ['alpha_tool', 'beta_tool', 'gamma_tool', 'delta_tool']) {
    assert.deepEqual(ownersOf(rows, name), ['@scope/pkg-x'], name + ' 必须归因到 scoped 包：' + JSON.stringify(rows))
  }
  assert.deepEqual(warnings, [])
})

test('坏插件目录/缺失插件/package.json 读失败：只写 warning，不抛，其他插件照常归因', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'good-plugin', {
    'lib/index.js': 'ctx.tools.register(defineTool({ name: "good_tool" }))\n',
  })
  // A directory where package.json should be: readFile throws EISDIR/EPERM.
  await mkdir(join(profilePath, 'node_modules', 'broken-plugin', 'package.json'), { recursive: true })
  const { rows, warnings } = await attributeTools({
    tools: [tool('good_tool'), tool('nobody_tool')],
    plugins: [
      { name: 'missing-plugin', source: 'npm' },
      { name: 'broken-plugin', source: 'npm' },
      { name: 'good-plugin', source: 'npm' },
    ],
    profilePath,
  })
  assert.deepEqual(ownersOf(rows, 'good_tool'), ['good-plugin'])
  assert.deepEqual(rowsNamed(rows, 'nobody_tool'), [{ name: 'nobody_tool', description: 'nobody_tool 工具' }])
  for (const pkg of ['missing-plugin', 'broken-plugin']) {
    assert.ok(
      warnings.some((message) => message.includes('读取插件') && message.includes(pkg)),
      '插件 ' + pkg + ' 读取失败必须留下 warning：' + JSON.stringify(warnings),
    )
  }
})

test('profilePath 为空/目录不存在/缺 node_modules：rows 原样无 owner + warning，不抛', async () => {
  const tools = [tool('read', 'Read a file'), tool('write')]
  for (const profilePath of ['', join(tmpdir(), 'guizhi-attr-does-not-exist-' + process.pid)]) {
    const { rows, warnings } = await attributeTools({
      tools,
      plugins: [{ name: 'some-plugin', source: 'npm' }],
      profilePath,
    })
    assert.deepEqual(rows, [
      { name: 'read', description: 'Read a file' },
      { name: 'write', description: 'write 工具' },
    ])
    assert.ok(warnings.length >= 1, 'profile 不可用必须告警')
    assert.ok(warnings.some((message) => message.includes('profile')), JSON.stringify(warnings))
  }

  const emptyProfile = await makeProfile()
  const missingModules = await attributeTools({ tools, plugins: [{ name: 'some-plugin', source: 'npm' }], profilePath: emptyProfile })
  // makeProfile creates node_modules; remove it to pin the "no node_modules" branch.
  await rm(join(emptyProfile, 'node_modules'), { recursive: true, force: true })
  const afterRemoval = await attributeTools({ tools, plugins: [{ name: 'some-plugin', source: 'npm' }], profilePath: emptyProfile })
  assert.equal(missingModules.rows.length, 2)
  assert.equal(afterRemoval.rows.length, 2)
  assert.equal(ownersOf(afterRemoval.rows, 'read').length, 0)
  assert.ok(afterRemoval.warnings.some((message) => message.includes('node_modules')), JSON.stringify(afterRemoval.warnings))
})

test('只归因 source=npm：patch 插件即使源码注册同名工具也不归因', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'patch-plugin', {
    'lib/index.js': 'ctx.tools.register(defineTool({ name: "patch_tool" }))\n',
  })
  const { rows, warnings } = await attributeTools({
    tools: [tool('patch_tool')],
    plugins: [{ name: 'patch-plugin', source: 'patch' }],
    profilePath,
  })
  assert.deepEqual(rowsNamed(rows, 'patch_tool'), [{ name: 'patch_tool', description: 'patch_tool 工具' }])
  assert.ok(warnings.some((message) => message.includes('无法归因')), JSON.stringify(warnings))
})

test('单插件文件数上限：最多读 200 个文件（含 package.json），超限文件不读且有 warning', async () => {
  const profilePath = await makeProfile()
  const files = { 'aaa.js': 'ctx.tools.register(defineTool({ name: "early_tool" }))\n' }
  for (let index = 0; index < 203; index += 1) {
    files['file-' + String(index).padStart(3, '0') + '.js'] = '// filler ' + index + '\n'
  }
  files['zzz.js'] = 'ctx.tools.register(defineTool({ name: "late_tool" }))\n'
  const root = await installPlugin(profilePath, 'huge-plugin', files)

  /** @type {string[]} */
  const reads = []
  const io = {
    readFile: async (file, encoding) => {
      reads.push(file)
      return readFile(file, encoding)
    },
  }
  const { rows, warnings } = await attributeTools({
    tools: [tool('early_tool'), tool('late_tool')],
    plugins: [{ name: 'huge-plugin', source: 'npm' }],
    profilePath,
    io,
  })
  const pluginReads = reads.filter((file) => file.startsWith(root))
  assert.ok(pluginReads.length <= 200, '单插件读取文件数必须 ≤200，实际 ' + pluginReads.length)
  assert.equal(pluginReads.some((file) => file.endsWith('zzz.js')), false, '超过文件数上限后不得再读文件')
  assert.deepEqual(ownersOf(rows, 'early_tool'), ['huge-plugin'])
  assert.deepEqual(ownersOf(rows, 'late_tool'), [], '超限后被跳过的文件不得产生归因')
  assert.ok(warnings.some((message) => message.includes('上限') || message.includes('截断')), JSON.stringify(warnings))
})

test('单插件字节上限：大于 1MB 的文件不读，仍能扫描小文件并归因', async () => {
  const profilePath = await makeProfile()
  const bigBody = "ctx.tools.register(defineTool({ name: 'big_tool' }))\n" + ' '.repeat(1_200_000)
  const root = await installPlugin(profilePath, 'fat-plugin', {
    '00-big.js': bigBody,
    '10-small.js': 'ctx.tools.register(defineTool({ name: "small_tool" }))\n',
  })
  /** @type {string[]} */
  const reads = []
  const io = {
    readFile: async (file, encoding) => {
      reads.push(file)
      return readFile(file, encoding)
    },
  }
  const { rows, warnings } = await attributeTools({
    tools: [tool('big_tool'), tool('small_tool')],
    plugins: [{ name: 'fat-plugin', source: 'npm' }],
    profilePath,
    io,
  })
  assert.equal(reads.some((file) => file.endsWith('00-big.js')), false, '超字节上限的文件不得被读取')
  assert.ok(reads.some((file) => file.endsWith('10-small.js')), '未超限的小文件仍应读取')
  assert.deepEqual(ownersOf(rows, 'small_tool'), ['fat-plugin'])
  assert.deepEqual(ownersOf(rows, 'big_tool'), [])
  assert.ok(warnings.some((message) => message.includes('上限') || message.includes('截断')), JSON.stringify(warnings))
})

test('跳过插件内部的嵌套 node_modules，不读其中的源码', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'nested-plugin', {
    'lib/index.js': 'ctx.tools.register(defineTool({ name: "own_tool" }))\n',
    'node_modules/dep/lib/index.js': 'ctx.tools.register(defineTool({ name: "nested_tool" }))\n',
  })
  const { rows, warnings } = await attributeTools({
    tools: [tool('own_tool'), tool('nested_tool')],
    plugins: [{ name: 'nested-plugin', source: 'npm' }],
    profilePath,
  })
  assert.deepEqual(ownersOf(rows, 'own_tool'), ['nested-plugin'])
  assert.deepEqual(ownersOf(rows, 'nested_tool'), [])
  assert.ok(warnings.some((message) => message.includes('无法归因') && message.includes('nested_tool')), JSON.stringify(warnings))
})

test('无法归因汇总：一条有界 warning；重复读取失败去重', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'quiet-plugin', {
    'lib/index.js': '// registers nothing\n',
  })
  const tools = []
  for (let index = 0; index < 30; index += 1) tools.push(tool('tool_' + String(index).padStart(2, '0')))
  const { rows, warnings } = await attributeTools({
    tools,
    plugins: [
      { name: 'missing-plugin', source: 'npm' },
      { name: 'missing-plugin', source: 'npm' },
      { name: 'quiet-plugin', source: 'npm' },
    ],
    profilePath,
  })
  assert.equal(rows.length, 30)
  assert.ok(rows.every((row) => Object.hasOwn(row, 'owner') === false))
  const unattributed = warnings.filter((message) => message.includes('无法归因'))
  assert.equal(unattributed.length, 1)
  assert.ok(unattributed[0].length <= 500, '单条 warning 必须有界：' + unattributed[0].length)
  assert.match(unattributed[0], /tool_00/)
  assert.match(unattributed[0], /30/)
  const missing = warnings.filter((message) => message.includes('missing-plugin'))
  assert.equal(missing.length, 1, '重复读取失败只保留一条 warning：' + JSON.stringify(warnings))
})

test('输入畸形不抛：tools/plugins/profilePath 非预期形状按空处理', async () => {
  for (const input of [{}, { tools: null, plugins: null, profilePath: null }, { tools: 'nope', plugins: 'nope', profilePath: 42 }]) {
    const { rows, warnings } = await attributeTools(input)
    assert.ok(Array.isArray(rows))
    assert.ok(Array.isArray(warnings))
  }
})

test('withAttribution：listTools 用归因结果覆盖、warnings 合并去重、takeWarnings 清空自身并委托 host', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'wrap-plugin', {
    'lib/index.js': 'ctx.tools.register(defineTool({ name: "wrapped_tool" }))\n',
  })
  let hostWarnings = ['宿主旧告警']
  let takeCalls = 0
  const host = {
    async listTools() {
      return [tool('wrapped_tool', 'W'), tool('orphan_tool', 'O')]
    },
    async listPlugins() {
      return [{ name: 'wrap-plugin', version: '1.0.0', source: 'npm' }, { name: 'patch-only', source: 'patch' }]
    },
    async listSkills() {
      return [{ name: 's', source: 'user' }]
    },
    sessionEvents() {
      return null
    },
    profilePath() {
      return '/definitely/not/the/profile'
    },
    dshVersion() {
      return '0.0.1-test'
    },
    get warnings() {
      return hostWarnings.slice()
    },
    takeWarnings() {
      takeCalls += 1
      const batch = hostWarnings.slice()
      hostWarnings = []
      return batch
    },
  }
  const wrapped = withAttribution(host, { profilePath })
  const first = await wrapped.listTools()
  const second = await wrapped.listTools()
  assert.deepEqual(first, second)
  assert.deepEqual(ownersOf(first, 'wrapped_tool'), ['wrap-plugin'])
  assert.deepEqual(rowsNamed(first, 'orphan_tool'), [{ name: 'orphan_tool', description: 'O' }])

  const snapshot = wrapped.warnings
  assert.ok(snapshot.includes('宿主旧告警'), JSON.stringify(snapshot))
  const unattributed = snapshot.filter((message) => message.includes('无法归因'))
  assert.equal(unattributed.length, 1, '归因 warning 必须去重：' + JSON.stringify(snapshot))
  assert.equal(snapshot.filter((message) => message === '宿主旧告警').length, 1)
  snapshot.push('调用方篡改')
  assert.equal(wrapped.warnings.includes('调用方篡改'), false, 'warnings getter 必须返回快照')

  // Delegation keeps HostAdapter semantics.
  assert.deepEqual(await wrapped.listPlugins(), await host.listPlugins())
  assert.deepEqual(await wrapped.listSkills(), await host.listSkills())
  assert.equal(wrapped.sessionEvents('2026-01-01'), null)
  assert.equal(wrapped.profilePath(), '/definitely/not/the/profile')
  assert.equal(wrapped.dshVersion(), '0.0.1-test')

  const batch = wrapped.takeWarnings()
  assert.ok(batch.includes('宿主旧告警'), JSON.stringify(batch))
  assert.ok(batch.some((message) => message.includes('无法归因')))
  assert.equal(takeCalls, 1, 'takeWarnings 必须委托 host')
  assert.deepEqual(wrapped.warnings, [], '取走后自身与宿主批量都必须清空')

  // The next listTools batch starts a fresh warning set.
  await wrapped.listTools()
  const next = wrapped.warnings
  assert.ok(next.some((message) => message.includes('无法归因')), JSON.stringify(next))
  wrapped.takeWarnings()
})

test('withAttribution：host 缺方法时 undefined 安全，listTools 不抛', async () => {
  const wrapped = withAttribution({})
  assert.equal(wrapped.listPlugins(), undefined)
  assert.equal(wrapped.listSkills(), undefined)
  assert.equal(wrapped.sessionEvents(), undefined)
  assert.equal(wrapped.profilePath(), undefined)
  assert.equal(wrapped.dshVersion(), undefined)
  assert.deepEqual(await wrapped.listTools(), [])
  assert.ok(wrapped.warnings.some((message) => message.includes('listTools')), JSON.stringify(wrapped.warnings))
  assert.deepEqual(wrapped.takeWarnings().length > 0, true)
  assert.deepEqual(wrapped.warnings, [])
})

test('withAttribution：host.warnings 抛错不外溢', async () => {
  const wrapped = withAttribution({
    get warnings() {
      throw new Error('boom-warnings')
    },
    async listTools() {
      return []
    },
  })
  await wrapped.listTools()
  assert.ok(Array.isArray(wrapped.warnings))
})

test('样例/测试数据里的 name: 字段不算注册：必须有工具定义键或注册调用才归因', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'fixture-data-plugin', {
    'test-smoke.mjs': [
      '// session-event fixture, not a tool registration',
      "const events = [{ type: 'tool/call', seq: 9, data: { turn: 1, name: 'team_task_update', arguments: '{}' } }]",
    ].join('\n'),
  })
  await installPlugin(profilePath, 'real-plugin', {
    'lib/index.js': 'ctx.tools.register(defineTool({ name: "team_task_update", description: "real" }))\n',
  })
  const { rows, warnings } = await attributeTools({
    tools: [tool('team_task_update')],
    plugins: [
      { name: 'fixture-data-plugin', source: 'npm' },
      { name: 'real-plugin', source: 'npm' },
    ],
    profilePath,
  })
  assert.deepEqual(ownersOf(rows, 'team_task_update'), ['real-plugin'], '样例数据不得产生归因：' + JSON.stringify(rows))
  assert.equal(rows.length, 1, '单个真实来源只输出一行')
  assert.deepEqual(warnings, [])
})

test('本地注册封装别名（reg(t({...}))) 的真实注册仍归因', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'alias-plugin', {
    'lib/index.js': [
      'function defineToolWrapper(opts) { return defineTool(opts) }',
      'const t = (opts) => { return defineToolWrapper({ ...opts, extra: 1 }) }',
      'const reg = (def) => ctx.tools.register(def)',
      "reg(t({ name: 'aliased_tool', description: 'd', parameters: {} }))",
    ].join('\n'),
  })
  const { rows, warnings } = await attributeTools({
    tools: [tool('aliased_tool')],
    plugins: [{ name: 'alias-plugin', source: 'npm' }],
    profilePath,
  })
  assert.deepEqual(ownersOf(rows, 'aliased_tool'), ['alias-plugin'], JSON.stringify(warnings))
})

test('只有 helper 对象 + getter description、无 defineTool/register 证据：不归因（ego_space_* 类收紧）', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'helper-only-plugin', {
    'lib/index.js': 'reg(t({ name: "helper_tool", get description() { return "d" }, parameters: {} }))\n',
  })
  const { rows, warnings } = await attributeTools({
    tools: [tool('helper_tool')],
    plugins: [{ name: 'helper-only-plugin', source: 'npm' }],
    profilePath,
  })
  assert.deepEqual(ownersOf(rows, 'helper_tool'), [])
  assert.ok(warnings.some((message) => message.includes('无法归因')), JSON.stringify(warnings))
})

test('普通对象带 name/description/execute 定义键、但无注册调用：不得单独成证据', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'object-only-plugin', {
    'lib/data.js': "const sample = { name: 'object_only_tool', description: 'fake', execute: () => {} }\n",
  })
  const { rows, warnings } = await attributeTools({
    tools: [tool('object_only_tool')],
    plugins: [{ name: 'object-only-plugin', source: 'npm' }],
    profilePath,
  })
  assert.deepEqual(ownersOf(rows, 'object_only_tool'), [])
  assert.ok(warnings.some((message) => message.includes('无法归因')), JSON.stringify(warnings))
})

test('超大 package.json 先 stat 再读：不读入，仍给出同一上限 warning', async () => {
  const profilePath = await makeProfile()
  const padding = 'x'.repeat(1_100_000)
  await installPlugin(profilePath, 'huge-manifest-plugin', {
    'package.json': '{"name":"huge-manifest-plugin","padding":"' + padding + '"}',
    'lib/index.js': 'ctx.tools.register(defineTool({ name: "hidden_tool", description: "x" }))\n',
  })
  const reads = []
  const io = {
    readFile: async (file, encoding) => {
      reads.push(file)
      return readFile(file, encoding)
    },
  }
  const { rows, warnings } = await attributeTools({
    tools: [tool('hidden_tool')],
    plugins: [{ name: 'huge-manifest-plugin', source: 'npm' }],
    profilePath,
    io,
  })
  assert.equal(reads.some((file) => file.endsWith('package.json')), false, '超大 package.json 不得先读入')
  assert.deepEqual(ownersOf(rows, 'hidden_tool'), [])
  assert.ok(warnings.some((message) => message.includes('上限') || message.includes('截断')), JSON.stringify(warnings))
})

test('排除测试/fixture 路径：test/、__tests__/、fixtures/、*.test.* 内的注册不算', async () => {
  const profilePath = await makeProfile()
  const registration = (name) => 'ctx.tools.register(defineTool({ name: "' + name + '", description: "x" }))\n'
  await installPlugin(profilePath, 'paths-plugin', {
    'lib/index.js': registration('real_tool'),
    'test/register.js': registration('test_tool'),
    '__tests__/register.js': registration('underscore_test_tool'),
    'fixtures/mock.js': registration('fixture_tool'),
    'lib/foo.test.js': registration('dot_test_tool'),
    'lib/bar.spec.mjs': registration('spec_tool'),
  })
  const tools = ['real_tool', 'test_tool', 'underscore_test_tool', 'fixture_tool', 'dot_test_tool', 'spec_tool'].map((name) => tool(name))
  const { rows, warnings } = await attributeTools({
    tools,
    plugins: [{ name: 'paths-plugin', source: 'npm' }],
    profilePath,
  })
  assert.deepEqual(ownersOf(rows, 'real_tool'), ['paths-plugin'])
  for (const name of ['test_tool', 'underscore_test_tool', 'fixture_tool', 'dot_test_tool', 'spec_tool']) {
    assert.deepEqual(ownersOf(rows, name), [], name + ' 位于测试/fixture 路径，不得归因')
  }
  assert.ok(warnings.some((message) => message.includes('无法归因')), JSON.stringify(warnings))
})

test('恰好 200 个文件（199 源文件 + manifest）不误报截断', async () => {
  const profilePath = await makeProfile()
  const files = {}
  for (let index = 0; index < 198; index += 1) files['file-' + String(index).padStart(3, '0') + '.js'] = '// filler ' + index + '\n'
  files['zzz-boundary.js'] = 'ctx.tools.register(defineTool({ name: "boundary_tool", description: "x" }))\n'
  await installPlugin(profilePath, 'boundary-plugin', files)
  const { rows, warnings } = await attributeTools({
    tools: [tool('boundary_tool')],
    plugins: [{ name: 'boundary-plugin', source: 'npm' }],
    profilePath,
  })
  assert.deepEqual(ownersOf(rows, 'boundary_tool'), ['boundary-plugin'])
  assert.deepEqual(warnings, [], '恰好 200 个文件不得误报截断：' + JSON.stringify(warnings))
})

test('目录条目安全上限使用单独文案，不复用「200 个文件 / 1MB」', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'walk-limit-plugin', {
    'lib/index.js': 'ctx.tools.register(defineTool({ name: "walk_tool", description: "x" }))\n',
  })
  const root = join(profilePath, 'node_modules', 'walk-limit-plugin')
  const fakeDir = (name) => ({ name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false })
  const io = {
    readdir: async (dir) => (dir === root ? Array.from({ length: 5001 }, (_, index) => fakeDir('d' + String(index).padStart(4, '0'))) : []),
  }
  const { warnings } = await attributeTools({
    tools: [tool('walk_tool')],
    plugins: [{ name: 'walk-limit-plugin', source: 'npm' }],
    profilePath,
    io,
  })
  assert.ok(warnings.some((message) => message.includes('安全上限')), JSON.stringify(warnings))
  assert.equal(warnings.some((message) => message.includes('200 个文件 / 1MB')), false, '目录条目上限不得复用文件/字节上限文案')
})

test('扩展名白名单：.ts 内注册不得命中', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'ts-plugin', {
    'lib/register.ts': 'ctx.tools.register(defineTool({ name: "ts_tool", description: "x" }))\n',
  })
  const { rows, warnings } = await attributeTools({
    tools: [tool('ts_tool')],
    plugins: [{ name: 'ts-plugin', source: 'npm' }],
    profilePath,
  })
  assert.deepEqual(ownersOf(rows, 'ts_tool'), [])
  assert.ok(warnings.some((message) => message.includes('无法归因')), JSON.stringify(warnings))
})

test('symlink：嵌套条目跳过；插件根目录 symlink 跟随（pnpm 豁免）', async (t) => {
  const profilePath = await makeProfile()
  const registration = (name) => 'ctx.tools.register(defineTool({ name: "' + name + '", description: "x" }))\n'
  const pluginRoot = await installPlugin(profilePath, 'symlink-plugin', { 'lib/index.js': registration('own_tool') })
  const outside = join(profilePath, 'outside-registrations')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'linked.js'), registration('linked_tool'))
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  try {
    await symlink(outside, join(pluginRoot, 'linked'), linkType)
  } catch (error) {
    t.skip('当前平台/权限不支持创建符号链接，跳过 symlink 用例：' + String(error?.code ?? error))
    return
  }
  const realRoot = join(profilePath, 'real-root')
  await mkdir(join(realRoot, 'lib'), { recursive: true })
  await writeFile(join(realRoot, 'package.json'), JSON.stringify({ name: 'root-link-plugin', version: '1.0.0' }))
  await writeFile(join(realRoot, 'lib', 'index.js'), registration('root_link_tool'))
  try {
    await symlink(realRoot, join(profilePath, 'node_modules', 'root-link-plugin'), linkType)
  } catch (error) {
    t.skip('当前平台/权限不支持创建插件根符号链接，跳过根 symlink 用例：' + String(error?.code ?? error))
    return
  }
  const { rows } = await attributeTools({
    tools: [tool('own_tool'), tool('linked_tool'), tool('root_link_tool')],
    plugins: [
      { name: 'symlink-plugin', source: 'npm' },
      { name: 'root-link-plugin', source: 'npm' },
    ],
    profilePath,
  })
  assert.deepEqual(ownersOf(rows, 'own_tool'), ['symlink-plugin'])
  assert.deepEqual(ownersOf(rows, 'linked_tool'), [], '嵌套 symlink 条目必须跳过')
  assert.deepEqual(ownersOf(rows, 'root_link_tool'), ['root-link-plugin'], '插件根目录 symlink 必须跟随（pnpm 豁免）')
})

test('非法插件名/路径穿越被拒绝，不读盘不抛', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'good-plugin', { 'lib/index.js': '// none\n' })
  const reads = []
  const io = {
    readFile: async (file, encoding) => {
      reads.push(file)
      return readFile(file, encoding)
    },
  }
  const { rows, warnings } = await attributeTools({
    tools: [tool('safe_tool')],
    plugins: [
      { name: '../evil', source: 'npm' },
      { name: 'a/b/c', source: 'npm' },
      { name: 'C:/abs/path', source: 'npm' },
      { name: '@bad', source: 'npm' },
    ],
    profilePath,
    io,
  })
  assert.deepEqual(rows, [{ name: 'safe_tool', description: 'safe_tool 工具' }])
  assert.ok(warnings.filter((message) => message.includes('非法插件名')).length >= 1, JSON.stringify(warnings))
  assert.deepEqual(reads, [], '非法插件名不得触发任何文件读取')
})

test('单文件读失败聚合 warning，其他文件照常归因', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'read-failure-plugin', {
    'lib/index.js': 'ctx.tools.register(defineTool({ name: "ok_tool", description: "x" }))\n',
    'lib/broken.js': 'ctx.tools.register(defineTool({ name: "bad_tool", description: "x" }))\n',
  })
  const io = {
    readFile: async (file, encoding) => {
      if (file.endsWith('broken.js')) throw new Error('EACCES: simulated read failure')
      return readFile(file, encoding)
    },
  }
  const { rows, warnings } = await attributeTools({
    tools: [tool('ok_tool'), tool('bad_tool')],
    plugins: [{ name: 'read-failure-plugin', source: 'npm' }],
    profilePath,
    io,
  })
  assert.deepEqual(ownersOf(rows, 'ok_tool'), ['read-failure-plugin'])
  assert.deepEqual(ownersOf(rows, 'bad_tool'), [])
  const failure = warnings.filter((message) => message.includes('文件失败'))
  assert.equal(failure.length, 1, '读失败必须聚合成一条 warning：' + JSON.stringify(warnings))
  assert.match(failure[0], /broken\.js/)
})

test('register( 邻近但非注册实参的引号工具名不得归因', async () => {
  const profilePath = await makeProfile()
  await installPlugin(profilePath, 'theme-plugin', {
    'lib/theme.js': [
      'const themeRegistry = { register(value) { return value } }',
      "themeRegistry.register('dark')",
      "const label = 'theme_tool'",
    ].join('\n'),
  })
  const { rows, warnings } = await attributeTools({
    tools: [tool('theme_tool')],
    plugins: [{ name: 'theme-plugin', source: 'npm' }],
    profilePath,
  })
  assert.deepEqual(ownersOf(rows, 'theme_tool'), [])
  assert.ok(warnings.some((message) => message.includes('无法归因')), JSON.stringify(warnings))
})
