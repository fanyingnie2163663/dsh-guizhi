import test from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYaml } from 'yaml'
import { buildPack } from '../lib/packs.js'
import { SKILL_FILE, buildPackSkill, isSkillPackName, skillNameForPack, truncateSkillText } from '../lib/skillpack.js'

/**
 * S2 skillpack: compile a pack (装配清单) into a DSH workflow skill (SKILL.md).
 *
 * The module is pure: no disk, no host service, no clock. These tests pin the
 * output contract (frontmatter, deterministic content, row grouping, legacy and
 * empty fallbacks) and the path-safety helpers apply() relies on.
 */

/** A D7 map with two stages, declared tools/skills and per-capability evidence. */
function makeMap() {
  return {
    scenarios: ['dev'],
    stages: [
      {
        id: 'understand',
        title: '理解需求',
        capabilities: [
          { id: 'read-code', title: '读代码', status: 'have', evidence: { source: 'scan', tools: ['read'], used30d: 9 } },
          { id: 'brainstorm', title: '头脑风暴', status: 'have', evidence: { source: 'skill', skills: ['brainstorming'] } },
        ],
        tools: ['read'],
        skills: ['brainstorming'],
      },
      {
        id: 'deliver',
        title: '交付',
        capabilities: [{ id: 'ship', title: '交付代码', status: 'missing', evidence: { source: 'scan', tool: 'edit' } }],
        tools: ['edit'],
      },
    ],
  }
}

/** One real buildPack product: deterministic id from title + stageIds. */
function makePack(map = makeMap(), stageIds = ['understand', 'deliver'], title = '研发交付包') {
  return buildPack({ map, stageIds, title })
}

/** Parse the YAML frontmatter of a generated SKILL.md. */
function frontmatterOf(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown)
  assert.ok(match, 'markdown 必须以 YAML frontmatter 开头：' + JSON.stringify(markdown.slice(0, 80)))
  return parseYaml(match[1])
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

test('buildPackSkill：返回 name/description/markdown，name=stow-pack-<id> 且是合法 kebab 名', () => {
  const pack = makePack()
  const skill = buildPackSkill(pack)
  assert.deepEqual(Object.keys(skill).sort(), ['description', 'markdown', 'name'])
  assert.equal(skill.name, 'stow-' + pack.id)
  assert.match(skill.name, KEBAB)
  assert.equal(typeof skill.description, 'string')
  assert.equal(typeof skill.markdown, 'string')
  assert.ok(skill.markdown.length > 0)
})

test('buildPackSkill：frontmatter 是合法 YAML，name/description 用 JSON 字符串安全引用', () => {
  const pack = makePack()
  const skill = buildPackSkill(pack)
  const frontmatter = frontmatterOf(skill.markdown)
  assert.deepEqual(frontmatter, { name: skill.name, description: skill.description, 'disable-model-invocation': true })
  // 引号/反斜杠等来自标题的字符不会破坏 frontmatter
  const quoted = makePack(makeMap(), ['understand'], '研发"包" \\ 交付')
  const quotedSkill = buildPackSkill(quoted)
  const quotedFrontmatter = frontmatterOf(quotedSkill.markdown)
  assert.equal(quotedFrontmatter.name, quotedSkill.name)
  assert.equal(quotedFrontmatter.description, quotedSkill.description)
  assert.equal(quotedFrontmatter.description.includes('\n'), false)
})

test('description：中文单行，含标题与工具/技能数量，不含路径、用量、时间戳', () => {
  const pack = makePack()
  const description = buildPackSkill(pack).description
  assert.equal(description.includes('\n'), false)
  assert.ok(description.includes(pack.title), description)
  assert.ok(description.includes(String(pack.tools.length)), description)
  assert.ok(description.includes(String(pack.skills.length)), description)
  assert.ok(/[\u4e00-\u9fff]/.test(description), 'description 必须是中文')
  assert.doesNotMatch(description, /used30d|[A-Za-z]:\\|[\/](home|Users)[\/]|~\.dsh|T\d{2}:\d{2}:\d{2}/)
})

test('markdown：标题、适用说明、按 rows 分阶段列能力点/状态/工具/技能', () => {
  const pack = makePack()
  const markdown = buildPackSkill(pack).markdown
  assert.ok(markdown.includes('# ' + pack.title), '必须以装配清单标题开头')
  assert.ok(markdown.includes('## 适用说明'))
  assert.ok(markdown.includes('归置'))
  assert.ok(markdown.includes('## 阶段与能力点'))
  // rows 按阶段分组：阶段标题作为小标题，且保持 rows 里的阶段顺序
  assert.ok(markdown.includes('### 理解需求'))
  assert.ok(markdown.includes('### 交付'))
  assert.ok(markdown.indexOf('### 理解需求') < markdown.indexOf('### 交付'))
  // 每个能力点标题、状态、工具与技能
  assert.ok(markdown.includes('读代码'))
  assert.ok(markdown.includes('头脑风暴'))
  assert.ok(markdown.includes('交付代码'))
  assert.ok(markdown.includes('have'))
  assert.ok(markdown.includes('missing'))
  assert.ok(markdown.includes('read'))
  assert.ok(markdown.includes('brainstorming'))
  // 建议列表 / 执行步骤 / 验收清单
  assert.ok(markdown.includes('## 建议工具'))
  assert.ok(markdown.includes('## 建议技能'))
  assert.ok(markdown.includes('## 执行步骤'))
  assert.ok(markdown.includes('## 验收清单'))
  assert.ok(markdown.includes('read'))
  assert.ok(markdown.includes('edit'))
  assert.ok(markdown.includes('brainstorming'))
  assert.ok(markdown.includes('阶段「理解需求」'))
})

test('旧 pack（无 rows）退回 stageIds + tools/skills，仍生成合法技能', () => {
  const pack = makePack()
  const legacy = { ...pack }
  delete legacy.rows
  const skill = buildPackSkill(legacy)
  assert.equal(skill.name, 'stow-' + pack.id)
  assert.deepEqual(frontmatterOf(skill.markdown), { name: skill.name, description: skill.description, 'disable-model-invocation': true })
  assert.ok(skill.markdown.includes('understand'), '无 rows 时至少列出 stageIds')
  assert.ok(skill.markdown.includes('deliver'))
  assert.ok(skill.markdown.includes('## 建议工具'))
  assert.ok(skill.markdown.includes('read'))
  assert.ok(skill.markdown.includes('## 建议技能'))
  assert.ok(skill.markdown.includes('brainstorming'))
})

test('空包：仍生成合法技能，内容明确写「本装配清单没有工具/技能」', () => {
  const map = { scenarios: ['dev'], stages: [{ id: 'idle', title: '空阶段', capabilities: [] }] }
  const pack = buildPack({ map, stageIds: ['idle'], title: '空装配清单' })
  assert.deepEqual(pack.tools, [])
  assert.deepEqual(pack.skills, [])
  const skill = buildPackSkill(pack)
  assert.match(skill.name, KEBAB)
  assert.ok(skill.markdown.includes('本装配清单没有工具/技能'), '空包必须写明没有工具/技能')
  assert.deepEqual(frontmatterOf(skill.markdown), { name: skill.name, description: skill.description, 'disable-model-invocation': true })
  assert.ok(skill.markdown.includes('## 建议工具'))
  assert.ok(skill.markdown.includes('## 验收清单'))
})

test('确定性：同一 pack（createdAt 不同）输出完全一致，且不含时间戳/本机路径/用量数字', () => {
  const first = makePack()
  const second = { ...first, createdAt: '2000-01-01T00:00:00.000Z' }
  assert.deepEqual(buildPackSkill(first), buildPackSkill(second))
  // 深拷贝输入的输出也一致
  assert.deepEqual(buildPackSkill(second), buildPackSkill(JSON.parse(JSON.stringify(second))))
  const skill = buildPackSkill(first)
  assert.equal(skill.markdown.includes(first.createdAt), false, 'markdown 不得包含构建时间')
  assert.equal(skill.description.includes(first.createdAt), false)
  assert.doesNotMatch(skill.markdown, /used30d|T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
  assert.doesNotMatch(skill.markdown, /[A-Za-z]:\\|[\/](home|Users)[\/]|~\.dsh|\/tmp\//)
})

test('非法 pack：抛 name=SkillPackError 的可读错误，不带半成品输出', () => {
  const pack = makePack()
  const bad = [null, undefined, 42, {}, { ...pack, version: 2 }, { ...pack, tools: 'read' }, { ...pack, createdAt: 42 }]
  for (const value of bad) {
    let thrown
    assert.throws(
      () => buildPackSkill(value),
      (error) => {
        thrown = error
        assert.equal(error.name, 'SkillPackError', JSON.stringify(value))
        assert.match(error.message, /装配清单|校验/)
        return true
      },
      JSON.stringify(value),
    )
    assert.equal(Object.hasOwn(thrown, 'markdown'), false)
  }
})

test('isSkillPackName / skillNameForPack：只接受 kebab 小写名，非法 id 不用于拼路径', () => {
  assert.equal(SKILL_FILE, 'SKILL.md')
  for (const name of ['stow-pack-abcd1234', 'a', 'a-b-c', 'stow-pack-12345678']) {
    assert.equal(isSkillPackName(name), true, name)
  }
  for (const name of ['', 'Stow', 'stow_pack', 'stow-pack-', '-stow', 'stow--pack', 'stow-pack-../evil', 'stow pack', 42, null, undefined]) {
    assert.equal(isSkillPackName(name), false, String(name))
  }
  assert.equal(skillNameForPack({ id: 'pack-abcd1234' }), 'stow-pack-abcd1234')
  for (const id of ['pack/bad-name', 'pack\\bad', '', 'PACK-ABCD', '../escape']) {
    assert.throws(
      () => skillNameForPack({ id }),
      (error) => {
        assert.equal(error.name, 'SkillPackError')
        assert.match(error.message, /技能名|kebab|id/)
        return true
      },
      JSON.stringify(id),
    )
  }
  assert.throws(() => skillNameForPack(null), { name: 'SkillPackError' })
})
test('frontmatter：disable-model-invocation: true——安装后不默认进入模型技能目录，用户可手改', () => {
  const skill = buildPackSkill(makePack())
  const frontmatter = frontmatterOf(skill.markdown)
  assert.equal(frontmatter['disable-model-invocation'], true)
  assert.ok(skill.markdown.includes('disable-model-invocation: true'), 'frontmatter 必须显式写出该行：' + skill.markdown.slice(0, 160))
  // 保留既有字段
  assert.equal(frontmatter.name, skill.name)
  assert.equal(frontmatter.description, skill.description)
})

test('截断：title 超过 120 code point 时单行化并加省略号，markdown 使用截断后的标题', () => {
  const longTitle = '超长标题'.repeat(80) + '\n第二行标题'
  const pack = buildPack({ map: makeMap(), stageIds: ['understand', 'deliver'], title: longTitle })
  const skill = buildPackSkill(pack)
  const heading = /^# (.*)$/m.exec(skill.markdown)
  assert.ok(heading !== null, 'markdown 必须有标题行')
  assert.equal(Array.from(heading[1]).length, 120, '标题截断后正好 120 code point')
  assert.ok(heading[1].endsWith('…'), '截断必须加省略号：' + JSON.stringify(heading[1].slice(-5)))
  assert.equal(skill.markdown.includes('第二行标题'), false, '标题必须单行化，换行不能进入 markdown')
  assert.equal(skill.description.includes('\n'), false, 'description 必须单行')
  assert.ok(Array.from(skill.description).length <= 300, 'description 最长 300 code point')
})

test('truncateSkillText：按 code point 截断、超长加省略号、单行化；短文本原样返回', () => {
  assert.equal(truncateSkillText('abc', 5), 'abc')
  assert.equal(truncateSkillText('abcde', 5), 'abcde')
  assert.equal(truncateSkillText('abcdef', 5), 'abcd…')
  assert.equal(truncateSkillText('a\nb\tc', 10), 'a b c')
  assert.equal(truncateSkillText('😀😀😀😀', 3), '😀😀…')
  assert.equal(Array.from(truncateSkillText('x'.repeat(500), 120)).length, 120)
  assert.equal(Array.from(truncateSkillText('x'.repeat(500), 300)).length, 300)
  assert.equal(truncateSkillText(42, 10), '', '非字符串按空文本处理，不抛错')
})

