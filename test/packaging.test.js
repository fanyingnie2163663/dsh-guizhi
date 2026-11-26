import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root (this file lives in test/). */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

test('package manifest points every declared entry at a real file', async () => {
  const entries = [manifest.main, manifest.exports?.['.'], manifest.exports?.['./client'], manifest.dsh?.bundle?.patch]
  for (const relative of entries) {
    assert.equal(typeof relative, 'string', 'a declared entry must be a path string')
    const info = await stat(join(root, relative))
    assert.ok(info.isFile(), relative + ' must exist')
  }
})

test('host imports used by the linked profile row are declared as peerDependencies', () => {
  // The Host runtime resolves a bare import from a linked root only when the
  // importer package.json peerDependencies names that package (app-boot
  // ResolutionRouter.routeLinked reads readPeerNames). Without the declaration
  // the row fails to import with ERR_MODULE_NOT_FOUND and never activates --
  // see docs/host-notes.md section 8.1.
  const peers = manifest.peerDependencies ?? {}
  const range = peers['@deepseek-ai/dsh-tools']
  assert.equal(typeof range, 'string', 'peerDependencies must declare @deepseek-ai/dsh-tools')
  assert.notEqual(range.trim(), '')
})

test('client half registers under the package name the host serves', async () => {
  const source = await readFile(join(root, 'client.js'), 'utf8')
  const loaderAt = source.indexOf('__ModuleLoader__.load(')
  const idToken = "id: '" + manifest.name + "'"
  assert.ok(loaderAt >= 0, 'client.js must call window.__ModuleLoader__.load')
  assert.ok(source.indexOf(idToken) > loaderAt, 'loader registration id must equal the package name')
})

test('client declaration is a web platform with an inject array', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(manifest.dsh?.client?.inject))
})
