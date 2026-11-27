/**
 * Tests for the read-only disk skill scanner (真机缺陷 B：skills 清单滞后)
 * and its merge into the host adapter's listSkills.
 *
 * scanSkillRoots is pure I/O (node:fs + yaml) against temporary roots; no DSH
 * host is booted. The adapter tests use a fake cordis ctx with a fixed 32-row
 * skills.list plus temporary profileContext.home / cwd skill roots.
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostAdapter } from '../lib/host.js'
import { withAttribution } from '../lib/attribution.js'
import { parseSkillFrontmatter, scanSkillRoots } from '../lib/skillscan.js'

/** Temp roots removed after the suite. */
const cleanup = []
after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true })
})

/** @returns {Promise<string>} a fresh temp directory tracked for cleanup */
async function makeRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'guizhi-skillscan-'))
  cleanup.push(dir)
  return dir
}

/** Build a valid frontmatter block. */
function frontmatterText({ name, description = '说明' } = {}) {
  const lines = ['---']
  if (name !== undefined) lines.push('name: ' + name)
  if (description !== undefined) lines.push('description: ' + description)
  lines.push('---', '')
  return lines.join('\n') + '\n'
}

/** Write <root>/<dirName>/SKILL.md with valid YAML frontmatter. */
async function writePackage(root, dirName, { name, description = '说明', body = '# 正文\n' } = {}) {
  await mkdir(join(root, dirName), { recursive: true })
  await writeFile(join(root, dirName, 'SKILL.md'), frontmatterText({ name, description }) + body)
}

/** Write a flat file inside root. */
async function writeFlat(root, fileName, content) {
  await writeFile(join(root, fileName), content)
}

/** Fake cordis ctx: only the declared services are visible. */
function fakeCtx(services = {}) {
  return {
    logger: { warn() {} },
    get(name) {
      return Object.hasOwn(services, name) ? services[name] : undefined
    },
  }
}

/** Fake skills service returning a fixed row list. */
function fakeSkills(rows) {
  return { async list() { return rows } }
}

/** The host catalog the real-machine defect reported: exactly 32 rows. */
const HOST_SKILLS = Array.from({ length: 32 }, (_, index) => ({
  name: 'host-skill-' + String(index).padStart(2, '0'),
  source: 'host',
}))

/** @param {{name: string, source?: string}[]} rows @param {string} name */
function rowByName(rows, name) {
  const row = rows.find((item) => item.name === name)
  assert.ok(row !== undefined, '缺少技能 ' + name + '：' + JSON.stringify(rows.map((item) => item.name)))
  return row
}

/** Adapter options that keep the real ~/.agents out of the test (explicit temp dir). */
function hostAdapterOptions(home, extra = {}) {
  return { agentsHome: join(home, 'no-agents-home'), env: {}, argv: [], execPath: '', ...extra }
}

/** Fake ctx whose profileContext service carries the temp DSH home (and cwd). */
function hostCtx(home, services = {}, cwd) {
  return fakeCtx({ ...services, profileContext: cwd === undefined ? { home } : { home, cwd } })
}

/* ------------------------------------------------------------------ scanner */

test('scanSkillRoots：目录包与扁平 md 都被识别，source 来自传入 root', async () => {
  const root = await makeRoot()
  await writePackage(root, 'alpha', { name: 'alpha-skill', description: '甲' })
  await writeFlat(root, 'beta.md', frontmatterText({ name: 'beta-skill', description: '乙' }) + '# 正文\n')
  assert.deepEqual(await scanSkillRoots([{ path: root, source: 'user-dsh' }]), [
    { name: 'alpha-skill', source: 'user-dsh' },
    { name: 'beta-skill', source: 'user-dsh' },
  ])
})

test('scanSkillRoots：非法 frontmatter / name / description 与坏 YAML 跳过，不抛错', async () => {
  const root = await makeRoot()
  await writeFlat(root, 'a-no-frontmatter.md', '# 只有正文\n')
  await writeFlat(root, 'b-bad-yaml.md', '---\nname: [unclosed\n---\n')
  await writeFlat(root, 'c-bad-name.md', frontmatterText({ name: 'Bad_Name' }))
  await writeFlat(root, 'd-bad-name-space.md', frontmatterText({ name: 'with space' }))
  await writeFlat(root, 'e-no-description.md', '---\nname: no-description\n---\n')
  await writeFlat(root, 'f-number-description.md', '---\nname: number-description\ndescription: 42\n---\n')
  await writeFlat(root, 'g-ok.md', frontmatterText({ name: 'good-skill' }))
  assert.deepEqual(await scanSkillRoots([{ path: root, source: 'user-agents' }]), [
    { name: 'good-skill', source: 'user-agents' },
  ])
})

test('scanSkillRoots：不存在或不可读的 root 返回空结果而不抛错', async () => {
  const parent = await makeRoot()
  const fileRoot = join(parent, 'not-a-dir')
  await writeFile(fileRoot, 'x')
  const missing = join(parent, 'missing', 'skills')
  assert.deepEqual(
    await scanSkillRoots([
      { path: missing, source: 'user-dsh' },
      { path: fileRoot, source: 'broken' },
      { path: 42, source: 'invalid' },
      null,
      {},
    ]),
    [],
  )
})

test('scanSkillRoots：按 name 去重，多个 root 时首个 root 优先', async () => {
  const first = await makeRoot()
  const second = await makeRoot()
  await writePackage(first, 'dup', { name: 'duplicate' })
  await writePackage(second, 'dup', { name: 'duplicate' })
  await writePackage(second, 'unique', { name: 'unique-skill' })
  assert.deepEqual(await scanSkillRoots([{ path: first, source: 'user-dsh' }, { path: second, source: 'project-dsh' }]), [
    { name: 'duplicate', source: 'user-dsh' },
    { name: 'unique-skill', source: 'project-dsh' },
  ])
})

test('scanSkillRoots：超过大小上限或 frontmatter 窗口的文件被跳过', async () => {
  const root = await makeRoot()
  await writeFlat(root, 'a-big.md', frontmatterText({ name: 'big-skill' }) + 'x'.repeat(2000))
  await writeFlat(
    root,
    'b-long-frontmatter.md',
    '---\nname: long-frontmatter\ndescription: ' + 'd'.repeat(300) + '\n---\n',
  )
  await writeFlat(root, 'c-ok.md', frontmatterText({ name: 'ok-skill' }))
  assert.deepEqual(
    await scanSkillRoots([{ path: root, source: 'user-dsh' }], { maxSkillBytes: 1024, maxFrontmatterBytes: 128 }),
    [{ name: 'ok-skill', source: 'user-dsh' }],
  )
})

test('parseSkillFrontmatter：接受 BOM/标准写法，拒绝缺定界符、坏 YAML 与非对象', () => {
  assert.deepEqual(parseSkillFrontmatter('---\nname: alpha\ndescription: 说明\n---\n正文'), {
    name: 'alpha',
    description: '说明',
  })
  assert.deepEqual(parseSkillFrontmatter('\uFEFF---\nname: bom-skill\ndescription: 说明\n---\n'), {
    name: 'bom-skill',
    description: '说明',
  })
  assert.equal(parseSkillFrontmatter('# 只有正文'), null)
  assert.equal(parseSkillFrontmatter('---\nname: unclosed\n'), null)
  assert.equal(parseSkillFrontmatter('---\nname: [unclosed\n---\n'), null)
  assert.equal(parseSkillFrontmatter('---\n- just\n- a list\n---\n'), null)
  assert.equal(parseSkillFrontmatter(null), null)
})

/* ------------------------------------------------------- adapter: 合并行为 */

test('createHostAdapter.listSkills：32 条 host 技能 + 磁盘新技能，host 同名优先且按 name 排序', async () => {
  const home = await makeRoot()
  await writePackage(join(home, 'skills'), 'disk-new', { name: 'disk-only-skill' })
  await writePackage(join(home, 'skills'), 'host-dupe', { name: 'host-skill-00', description: '磁盘同名' })
  const adapter = createHostAdapter(hostCtx(home, { skills: fakeSkills(HOST_SKILLS) }), hostAdapterOptions(home))
  const rows = await adapter.listSkills()
  assert.equal(rows.length, 33, JSON.stringify(rows.map((row) => row.name)))
  assert.deepEqual(rowByName(rows, 'disk-only-skill'), { name: 'disk-only-skill', source: 'user-dsh' })
  assert.deepEqual(rowByName(rows, 'host-skill-00'), { name: 'host-skill-00', source: 'host' })
  const names = rows.map((row) => row.name)
  assert.deepEqual(names, names.slice().sort(), '合并结果必须按 name 排序')
})

test('createHostAdapter.listSkills：四个磁盘 root 的 source 映射正确', async () => {
  const home = await makeRoot()
  const cwd = await makeRoot()
  const agentsHome = await makeRoot()
  await writePackage(join(home, 'skills'), 'u-dsh', { name: 'user-dsh-skill' })
  await writePackage(join(agentsHome, 'skills'), 'u-agents', { name: 'user-agents-skill' })
  await writePackage(join(cwd, '.dsh', 'skills'), 'p-dsh', { name: 'project-dsh-skill' })
  await writePackage(join(cwd, '.agents', 'skills'), 'p-agents', { name: 'project-agents-skill' })
  const adapter = createHostAdapter(hostCtx(home, { skills: fakeSkills([]) }, cwd), {
    agentsHome,
    env: {},
    argv: [],
    execPath: '',
  })
  assert.deepEqual(await adapter.listSkills(), [
    { name: 'project-agents-skill', source: 'project-agents' },
    { name: 'project-dsh-skill', source: 'project-dsh' },
    { name: 'user-agents-skill', source: 'user-agents' },
    { name: 'user-dsh-skill', source: 'user-dsh' },
  ])
})

test('createHostAdapter.listSkills：磁盘 root 间同名取第一个 root，host 同名一律 host 优先', async () => {
  const home = await makeRoot()
  const cwd = await makeRoot()
  await writePackage(join(home, 'skills'), 'same', { name: 'shared-skill' })
  await writePackage(join(cwd, '.dsh', 'skills'), 'same', { name: 'shared-skill' })
  const adapter = createHostAdapter(
    hostCtx(home, { skills: fakeSkills([{ name: 'shared-skill', source: 'host' }]) }, cwd),
    hostAdapterOptions(home),
  )
  assert.deepEqual(await adapter.listSkills(), [{ name: 'shared-skill', source: 'host' }])
})

test('createHostAdapter.listSkills：host 服务缺失/抛错时仍返回磁盘结果，warning 只记一次', async () => {
  const home = await makeRoot()
  await writePackage(join(home, 'skills'), 'disk', { name: 'disk-only-skill' })
  const options = hostAdapterOptions(home)
  const missing = createHostAdapter(hostCtx(home), options)
  assert.deepEqual(await missing.listSkills(), [{ name: 'disk-only-skill', source: 'user-dsh' }])
  assert.equal(missing.warnings.filter((message) => message.includes('skills 服务不可用')).length, 1)
  for (const message of missing.takeWarnings()) assert.ok(message.includes('skills 服务不可用'))
  assert.deepEqual(missing.warnings, [], 'warning 只属于这一次调用，取走后为空')
  await missing.listSkills()
  assert.equal(
    missing.warnings.filter((message) => message.includes('skills 服务不可用')).length,
    1,
    '第二次调用仍只记一条 warning',
  )

  const failing = createHostAdapter(hostCtx(home, { skills: { async list() { throw new Error('boom') } } }), options)
  assert.deepEqual(await failing.listSkills(), [{ name: 'disk-only-skill', source: 'user-dsh' }])
  assert.equal(failing.warnings.filter((message) => message.includes('skills.list 失败')).length, 1)
  assert.ok(failing.warnings.some((message) => message.includes('boom')))
})

test('createHostAdapter.listSkills：某个磁盘 root 不可读时不抛错，host 结果照常返回', async () => {
  const home = await makeRoot()
  const notDir = join(home, 'not-a-dir')
  await writeFile(notDir, 'x')
  const adapter = createHostAdapter(
    hostCtx(notDir, { skills: fakeSkills([{ name: 'host-a', source: 'host' }]) }),
    hostAdapterOptions(notDir),
  )
  assert.deepEqual(await adapter.listSkills(), [{ name: 'host-a', source: 'host' }])
})

test('withAttribution 包装后的 listSkills 仍使用磁盘合并实现（重导出不丢新行为）', async () => {
  const home = await makeRoot()
  await writePackage(join(home, 'skills'), 'disk', { name: 'wrapped-skill' })
  const adapter = createHostAdapter(hostCtx(home, { skills: fakeSkills([]) }), hostAdapterOptions(home))
  const wrapped = withAttribution(adapter, { profilePath: '/nonexistent-guizhi-profile' })
  assert.deepEqual(await wrapped.listSkills(), [{ name: 'wrapped-skill', source: 'user-dsh' }])
})
