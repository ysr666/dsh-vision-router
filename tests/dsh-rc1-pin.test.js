import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RC1_PIN_PATH, readRc1Pin, validateRc1Pin } from '../scripts/dsh-rc1-pin.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db'
test('RC1 gate source is exact, immutable, and independent of Alpha', () => {
  assert.equal(RC1_PIN_PATH, path.join(root, 'config/dsh-rc1-settings-pin.json'))
  assert.deepEqual(readRc1Pin(), {version:'0.2.2-rc.1',sha:source})
  const alpha=JSON.parse(readFileSync(path.join(root,'config/dsh-alpha-settings-pin.json'),'utf8'))
  assert.equal(alpha.version,'0.2.2-alpha.3')
})
test('RC1 pin strictly rejects version drift and malicious or malformed inputs', () => {
  for (const invalid of [null,[],{}, {version:'0.2.2-alpha.3',sha:source},{version:'0.2.2-rc.2',sha:source},{version:'0.2.2-rc.1\nfoo=1',sha:source},{version:'0.2.2-rc.1',sha:source+'\nfoo=1'},{version:'0.2.2-rc.1',sha:'f'.repeat(40),other:true}]){
    assert.throws(()=>validateRc1Pin(invalid))
  }
})
test('RC1 read command creates exact GitHub step output and rejects writes', () => {
  const temp = mkdtempSync(path.join(tmpdir(), 'dvr-rc1-pin-'))
  try {
    const out=path.join(temp,'out')
    const script=path.join(root,'scripts/dsh-rc1-pin.mjs')
    const run=(args)=>spawnSync(process.execPath,[script,...args],{env:{...process.env,GITHUB_OUTPUT:out},encoding:'utf8'})
    assert.equal(run(['read']).status,0)
    assert.equal(readFileSync(out,'utf8'), 'version=0.2.2-rc.1\nsha='+source+'\n')
    assert.notEqual(run(['update',source]).status,0)
  }finally{rmSync(temp,{recursive:true,force:true})}
})
test('RC1 Host Gate validates exactly pinned source across all supported platforms', () => {
  const gate=readFileSync(path.join(root,'.github/workflows/dsh-022-rc1-host-gate.yml'),'utf8')
  const alpha=readFileSync(path.join(root,'.github/workflows/dsh-alpha-settings-host-gate.yml'),'utf8')
  const count=(str,needle)=>str.split(needle).length-1
  assert.equal(count(gate,'run: node dvr/scripts/dsh-rc1-pin.mjs read'),3)
  assert.equal(count(gate,'ref: '+ '$'+'{{ steps.pin.outputs.sha }}'),3)
  assert.match(gate,/node: \[24\.9\.0, 24\.21\.0\]/)
  assert.equal(count(gate,'node-version: 24.9.0'),2)
  assert.match(gate,/DSH_EXPECTED_COMMIT: /)
  assert.match(gate,/DVR_EXPECT_NATIVE_SETTINGS_ICON: '1'/)
  assert.match(gate,/dsh-preview-settings-browser-lifecycle-smoke\.mjs/)
  assert.match(gate,/dsh017-desktop-multiplugin-smoke\.mjs/)
  const scripts = new Set([...gate.matchAll(/(?:dvr\/|\.\.\/dvr\/)(scripts\/[a-zA-Z0-9-]+\.mjs)/g)].map((match) => match[1]))
  for (const script of scripts) assert.ok(readFileSync(path.join(root, script), 'utf8').length > 0, 'missing referenced script: ' + script)
  assert.doesNotMatch(gate,/node-version: 22\.19|dsh-alpha-pin\.mjs read|path: dsh-alpha|working-directory: dsh-alpha/)
  assert.match(alpha, /dsh-alpha-pin\.mjs read/)
  assert.match(alpha, /node: \[22\.19\.0, 24\.21\.0\]/)
})
