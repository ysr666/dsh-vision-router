// Offline release state machine: drives the real registry-identity CLI through
// every reachable partial state with a stubbed registry, and pins the GitHub
// Release phase's draft -> attach -> verify -> publish ordering in the workflow.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { releaseDistTag } from '../scripts/release-channel.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const STUB = path.join(ROOT, 'tests/fixtures/registry-fetch-stub.mjs')
const CLI = path.join(ROOT, 'scripts/release-registry-identity.mjs')
const WORKFLOW = path.join(ROOT, '.github/workflows/release.yml')

function runCli(args, { scenario, env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-state-'))
  const outputPath = path.join(dir, 'github-output')
  const result = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(STUB).href, CLI, ...args],
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

test('release channel maps reviewed semver classes but refuses unreviewed prereleases', () => {
  assert.equal(releaseDistTag('3.1.4'), 'latest')
  assert.equal(releaseDistTag('3.2.0-rc.0'), 'next')
  assert.equal(releaseDistTag('3.2.0-rc.5'), 'next')
  assert.equal(releaseDistTag('3.2.0-alpha.1'), 'alpha')
  for (const unreviewed of ['3.2.0-beta.1', '3.2.0-rc', '3.2.0-preview.3', '3.2.0-rc.0+build', 'garbage', 'v3.2.0']) {
    assert.throws(() => releaseDistTag(unreviewed), /unreviewed|noncanonical|invalid/, unreviewed)
  }
})

test('release workflow uses Node24 and keeps prereleases off default npm/GitHub latest', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const verify = workflow.slice(workflow.indexOf('  verify:'), workflow.indexOf('  tag:', workflow.indexOf('  verify:') + 1))
  const publish = workflow.slice(workflow.indexOf('  publish:'), workflow.indexOf('  github-release:'))
  const release = workflow.slice(workflow.indexOf('  github-release:'))
  assert.ok(verify.includes("node-version: '24.21.0'"))
  assert.ok(!verify.includes("node-version: '22'"))
  assert.ok(verify.includes('Verify release distribution channel before irreversible tag'))
  assert.ok(verify.includes('node scripts/release-channel.mjs'))
  assert.ok(verify.includes('npm_dist_tag: ' + '$' + '{{ steps.channel.outputs.dist_tag }}'))
  assert.ok(publish.includes('RELEASE_DIST_TAG: ' + '$' + '{{ needs.verify.outputs.npm_dist_tag }}'))
  assert.ok(publish.includes('npm publish "$PACKAGE_TARBALL" --tag "$RELEASE_DIST_TAG" --provenance --access public'))
  // The publish job checks out the immutable tag *without* installing project
  // dependencies. Never call the semver-dependent helper there: doing so after
  // tagging prevents OIDC publication with ERR_MODULE_NOT_FOUND.
  const publishStep = publish.slice(publish.indexOf('- name: Publish exact tarball to npm with trusted OIDC'))
  const publishBody = publishStep.split('\n      - name: Verify npm registry tarball identity')[0]
  assert.ok(publishBody.includes("const version = process.env.RELEASE_VERSION"))
  assert.ok(publishBody.includes("const tag = process.env.RELEASE_DIST_TAG"))
  assert.doesNotMatch(publishBody, /node scripts\/release-channel\.mjs|npm install|pnpm install/)

  assert.ok(release.includes('RELEASE_CREATE_FLAGS+=(--prerelease --latest=false)'))
  assert.ok(release.includes('gh release edit "$RELEASE_TAG" --draft=false --prerelease'))
  assert.ok(release.includes('gh release edit "$RELEASE_TAG" --draft=false --latest'))
  assert.ok(release.includes('--json isPrerelease --jq'))
})

test('publish-phase channel check is dependency-free and fails closed before npm OIDC', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const from = workflow.indexOf('- name: Publish exact tarball to npm with trusted OIDC')
  const to = workflow.indexOf('- name: Verify npm registry tarball identity', from)
  const publish = workflow.slice(from, to)
  const embedded = publish.match(/node <<'NODE'\n([\s\S]*?)\n          NODE/)
  assert.ok(embedded, 'self-contained publish-phase channel verification must exist')
  const script = embedded[1].split('\n').map((line) => line.replace(/^          /, '')).join('\n')
  const dir = mkdtempSync(path.join(tmpdir(), 'release-publish-no-deps-'))
  try {
    for (const [version, tag, status] of [
      ['3.1.5', 'latest', 0],
      ['3.2.0-rc.0', 'next', 0],
      ['3.2.0-alpha.1', 'alpha', 0],
      ['3.2.0-rc.0', 'latest', 1],
      ['3.1.5', 'next', 1],
      ['3.2.0-beta.1', 'next', 1],
      ['3.2.0-rc.0+dirty', 'next', 1],
      ['v3.2.0-rc.0', 'next', 1],
    ]) {
      const run = spawnSync(process.execPath, ['-e', script], {
        cwd: dir,
        env: { ...process.env, RELEASE_VERSION: version, RELEASE_DIST_TAG: tag },
        encoding: 'utf8',
      })
      assert.equal(run.status, status, `${version} / ${tag}: ${run.stderr}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

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

test('current release READMEs both retain the announcement bar required by the publishing workflow', () => {
  const version = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const expected = `v${version}`
  const notes = path.join(ROOT, 'docs', 'releases', `${expected}.md`)
  assert.ok(existsSync(notes), 'curated release notes must exist for the candidate version')
  for (const name of ['README.md', 'README.zh.md']) {
    const readme = readFileSync(path.join(ROOT, name), 'utf8')
    const lines = readme.split(/\r?\n/)
    const start = lines.findIndex(line => /^>\s*\[!WARNING\]/.test(line))
    assert.ok(start >= 0, `${name} must have a visible release announcement`)
    const contiguousBlock = lines.slice(start + 1).findIndex(line => !line.startsWith('>'))
    const block = lines.slice(start + 1, contiguousBlock < 0 ? undefined : start + 1 + contiguousBlock).join('\n')
    assert.match(block, new RegExp(expected.replaceAll('.', '\\.'), 'i'), `${name}: first warning block must mention candidate version`)
    assert.ok(block.includes(`docs/releases/${expected}.md`), `${name}: announcement must link to versioned notes`)
  }
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
  assert.ok(workflow.slice(Math.max(0, createIndex - 450), createIndex).includes('--draft'),
    'the release must start as a draft, including when flags are assembled before gh release create')
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
