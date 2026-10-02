// Offline release state machine: drives the real registry-identity CLI through
// every reachable partial state with a stubbed registry, and pins the GitHub
// Release phase's draft -> attach -> verify -> publish ordering in the workflow.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STUB = path.join(ROOT, 'tests/fixtures/registry-fetch-stub.mjs')
const CLI = path.join(ROOT, 'scripts/release-registry-identity.mjs')
const WORKFLOW = path.join(ROOT, '.github/workflows/release.yml')

function runCli(args, { scenario, env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-state-'))
  const outputPath = path.join(dir, 'github-output')
  const result = spawnSync(
    process.execPath,
    ['--import', STUB, CLI, ...args],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        RELEASE_REGISTRY_PROBE_ATTEMPTS: '2',
        RELEASE_REGISTRY_WAIT_ATTEMPTS: '2',
        RELEASE_REGISTRY_DELAY_MS: '1',
        RELEASE_TEST_SCENARIO: JSON.stringify(scenario),
        ...env,
      },
    },
  )
  const outputs = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : ''
  rmSync(dir, { recursive: true, force: true })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', outputs }
}

const visible = (sha1) => ({ status: 200, body: { name: 'dsh-vision-router', version: '2.3.0', dist: { shasum: sha1 } } })
const SHA = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

test('release state: an unpublished version permits the publish (probe=false)', () => {
  const run = runCli(['probe', '2.3.0', SHA], { scenario: [{ status: 404 }] })
  assert.equal(run.status, 0)
  assert.match(run.outputs, /^already_published=false$/m)
  assert.match(run.stdout, /publish is permitted/)
})

test('release state: an exact published identity is recognised and skips the publish (probe=true)', () => {
  const run = runCli(['probe', '2.3.0', SHA], { scenario: [visible(SHA)] })
  assert.equal(run.status, 0)
  assert.match(run.outputs, /^already_published=true$/m)
  assert.match(run.stdout, /exposes the exact tarball/)
})

test('release state: inspect reports the remote identity for an already published version', () => {
  const run = runCli(['inspect', '2.3.0'], { scenario: [visible(SHA)] })
  assert.equal(run.status, 0)
  assert.match(run.outputs, /^already_published=true$/m)
  assert.match(run.outputs, new RegExp(`^remote_sha1=${SHA}$`, 'm'))
})

test('release state: inspect distinguishes a never-published version from a registry failure', () => {
  const missing = runCli(['inspect', '2.3.0'], { scenario: [{ status: 404 }] })
  assert.equal(missing.status, 0)
  assert.match(missing.outputs, /^already_published=false$/m)
  const failing = runCli(['inspect', '2.3.0'], { scenario: [{ status: 500 }] })
  assert.equal(failing.status, 1)
  assert.match(failing.stderr, /::error::/)
})

test('release state: a published but different tarball refuses the run (fail closed)', () => {
  const run = runCli(['probe', '2.3.0', SHA], { scenario: [visible(OTHER)] })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /::error::/)
  assert.doesNotMatch(run.outputs, /already_published=false/)
})

test('release state: transient 500s before visibility still settle on a real identity', () => {
  const run = runCli(['wait', '2.3.0', SHA], { scenario: [{ status: 503 }, visible(SHA)] })
  assert.equal(run.status, 0)
  assert.match(run.stdout, /exposes the exact tarball/)
})

test('release state: a 401 from the registry fails instead of permitting a publish', () => {
  const run = runCli(['probe', '2.3.0', SHA], { scenario: [{ status: 401 }] })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /::error::/)
  assert.doesNotMatch(run.outputs, /already_published=false/)
})

test('release state: a network failure never turns into a publish permission', () => {
  const run = runCli(['probe', '2.3.0', SHA], { scenario: [{ throws: 'ECONNRESET' }] })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /::error::/)
  assert.doesNotMatch(run.outputs, /already_published=false/)
})

test('release state: post-publish wait times out deterministically when the version never appears', () => {
  const run = runCli(['wait', '2.3.0', SHA], { scenario: [{ status: 404 }] })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /did not expose/)
})

test('release workflow keeps the draft -> attach -> verify -> publish ordering', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const createIndex = workflow.indexOf('gh release create')
  const uploadIndex = workflow.indexOf('gh release upload')
  const verifyIndex = workflow.indexOf('attached release tarball does not match')
  const publishIndex = workflow.indexOf('gh release edit "$RELEASE_TAG" --draft=false')
  assert.ok(createIndex > 0 && uploadIndex > createIndex, 'the release must be created before assets are attached')
  assert.ok(verifyIndex > uploadIndex, 'attached assets must be verified after upload')
  assert.ok(publishIndex > verifyIndex, 'the release may only be published after asset verification')
  assert.match(workflow.slice(createIndex, uploadIndex), /--draft/, 'the release must start as a draft')
  assert.match(workflow.slice(uploadIndex, verifyIndex), /--clobber/, 're-running must be able to replace assets')
  assert.match(workflow, /gh release view "\$RELEASE_TAG" >\/dev\/null 2>&1/, 'an existing draft must be reused on re-run')
})

test('release workflow publishes npm only when the registry probe says unpublished', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const publishStep = workflow.indexOf('npm publish "$PACKAGE_TARBALL"')
  assert.ok(publishStep > 0, 'the publish step must exist')
  const before = workflow.slice(Math.max(0, publishStep - 400), publishStep)
  assert.match(before, /if: steps\.registry\.outputs\.already_published == 'false'/)
  const waitStep = workflow.indexOf('release-registry-identity.mjs wait')
  assert.ok(waitStep > publishStep, 'registry identity must be re-verified after the publish')
})
