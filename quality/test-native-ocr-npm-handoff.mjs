import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { validateResourceReport,verifyNpmPackDryRun,verifyRegistryPair } from './native-ocr-npm-handoff.mjs'

const mac={schemaVersion:1,target:'darwin-arm64',name:'dsh-vision-router-ocr-darwin-arm64',version:'1.0.0',
  filename:'dsh-vision-router-ocr-darwin-arm64-1.0.0.tgz',
  entry:{url:'https://registry.npmjs.org/dsh-vision-router-ocr-darwin-arm64/-/dsh-vision-router-ocr-darwin-arm64-1.0.0.tgz',
    bytes:27917268,sha256:'a5245c2420fa10ab9da124e2f8e308930a202c6239b4711b0dd73c14f29b78cd',npmBytes:27922000,npmSha256:'a'.repeat(64)},
  distributionReady:false,ownerPublicationAuthorized:false}
test('handoff accepts only exact reviewed inner archive and explicit stable package version',()=>{
  assert.equal(validateResourceReport(mac).target,'darwin-arm64')
  for(const report of [{...mac,version:'0.0.0-staging'}, {...mac,version:'latest'}, {...mac,target:'win32-x64'},
    {...mac,distributionReady:true}, {...mac,entry:{...mac.entry,sha256:'c'.repeat(64)}},
    {...mac,entry:{...mac.entry,npmBytes:100000000}}, {...mac,filename:'other.tgz'}])
    assert.throws(()=>validateResourceReport(report))
})
test('official npm dry-run must describe the exact payload and four allowed entries',()=>{
  const payload=Buffer.from('fixture')
  const row={name:mac.name,version:mac.version,filename:mac.filename,size:payload.length,
    shasum:createHash('sha1').update(payload).digest('hex'),
    integrity:'sha512-'+createHash('sha512').update(payload).digest('base64'),
    entryCount:4,bundled:[],files:['LICENSE','README.md','package.json','ppocrv6-small-darwin-arm64.tar.gz'].map(path=>({path}))}
  verifyNpmPackDryRun([row],mac,payload)
  assert.throws(()=>verifyNpmPackDryRun([{...row,integrity:'bad'}],mac,payload))
  assert.throws(()=>verifyNpmPackDryRun([{...row,files:[...row.files,{path:'postinstall.js'}]}],mac,payload))
})
test('one package or duplicate targets cannot yield a production catalog candidate',async()=>{
  await assert.rejects(verifyRegistryPair([mac],{fetchImpl:()=>{throw Error('unexpected fetch')}}))
  await assert.rejects(verifyRegistryPair([mac,mac],{fetchImpl:()=>{throw Error('unexpected fetch')}}))
})
