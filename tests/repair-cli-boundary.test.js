import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '../lib/repair-cli.js'

const capture = () => {
  const stdout = [], stderr = []
  return { stdout, stderr, io: { log: x => stdout.push(String(x)), error: x => stderr.push(String(x)) } }
}
function fixture(t) {
  const home = mkdtempSync(path.join(tmpdir(), 'dvr-recovery-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const profile = path.join(home, 'profiles', 'web')
  mkdirSync(profile, { recursive: true })
  const manifest = path.join(profile, 'package.json')
  const json = JSON.stringify({ dependencies: { 'dsh-vision-router': '^1.7.4' }, dsh: { profile: { bundles: ['dsh-vision-router'] } } })
  const plugin = path.join(profile, 'node_modules', 'dsh-vision-router')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-vision-router', version: '1.7.4', main: 'entry.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(path.join(plugin, 'entry.js'), 'export default {}\n')
  writeFileSync(path.join(plugin, 'cordis.patch.yml'), '- insert: []\n')
  const bytes = Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), Buffer.from(json)])
  writeFileSync(manifest, bytes)
  return { home, manifest, bytes, json, env: { DSH_HOME: home } }
}
test('retired Doctor, implicit invocation and unsupported flags never mutate or probe', async t => {
  const f = fixture(t)
  const previous = globalThis.fetch
  globalThis.fetch = () => { throw new Error('network forbidden') }
  try {
    for (const argv of [[], ['doctor'], ['doctor','--help'], ['doctor','--fix'], ['doctor','--upgrade-preflight'], ['--json'], ['repair','--profile','..'], ['repair','--check','--fix'], ['repair-sessions','--profile','web'], ['upgrade-preflight','--fix'], ['downgrade-preflight','stable-v2','--fix']]) {
      const c = capture()
      assert.equal(await run(argv,c.io,f.env),2,argv.join(' '))
      assert.deepEqual(readFileSync(f.manifest),f.bytes)
    }
    const c = capture()
    assert.equal(await run(['--help'],c.io,f.env),0)
    assert.match(c.stdout.join('\n'),/doctor command is retired/)
    assert.deepEqual(readFileSync(f.manifest),f.bytes)
  } finally { globalThis.fetch = previous }
})
test('repair --check is read-only and explicit repair preserves the original BOM-only fix', async t => {
  const f = fixture(t)
  const check = capture()
  assert.equal(await run(['repair','--profile','web','--check'],check.io,f.env),1)
  assert.deepEqual(readFileSync(f.manifest),f.bytes)
  const repair = capture()
  assert.equal(await run(['repair','--profile','web'],repair.io,f.env),0,repair.stderr.join('\n'))
  assert.equal(readFileSync(f.manifest,'utf8'),f.json)
})
test('downgrade preflight fails closed for unavailable history and never creates a store', async t => {
  const f = fixture(t)
  const c = capture()
  assert.equal(await run(['downgrade-preflight','legacy-only','--json'],c.io,f.env),1)
  const result = JSON.parse(c.stdout.join('\n'))
  assert.equal(result.ok,false)
  assert.equal(result.downgradePreflight.decision,'unknown')
  assert.equal(existsSync(path.join(f.home,'sessions')),false)
  assert.deepEqual(readFileSync(f.manifest),f.bytes)
})
test('read-only session check distinguishes incomplete tail from committed corruption', async t => {
  const f = fixture(t)
  const dir = path.join(f.home,'sessions','--project--','s')
  mkdirSync(dir,{recursive:true})
  const file = path.join(dir,'session.jsonl')
  const header = JSON.stringify({type:'session',version:0,id:'s',createdAt:1,delegationDepth:0})
  const start = JSON.stringify({type:'turn/start',seq:0,time:1,data:{turn:1}})
  const tail = header+'\n'+start
  writeFileSync(file,tail)
  const c = capture()
  assert.equal(await run(['repair-sessions','--check'],c.io,f.env),0)
  assert.match(c.stdout.join('\n'),/live\/incomplete tail advisories 1/)
  assert.equal(readFileSync(file,'utf8'),tail)
  const corrupt = header+'\n'+start+'\n'+JSON.stringify({type:'turn/end',seq:2,time:2,data:{turn:1,reason:{kind:'completed'}}})+'\n'
  writeFileSync(file,corrupt)
  const c2 = capture()
  assert.equal(await run(['repair-sessions','--check'],c2.io,f.env),1)
  assert.equal(readFileSync(file,'utf8'),corrupt)
})
