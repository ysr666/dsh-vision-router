// Maintainer-only exact-stage Desktop acceptance. Only the disposable package
// receives the candidate catalog and a Host-side HTTPS response fixture.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import { decodeBmp, replaceOnce, assertExactStagedArchive } from './native-ocr-staged-acceptance.mjs'
import { candidates } from './native-ocr-release-stage.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const target = process.platform + '-' + process.arch
const fixtureUrl = name => 'https://github.com/ysr666/dsh-vision-router/releases/download/native-ocr-staging-test/' + name

export function prepareExactDesktopOcr({ source, root, home, stage, bmp, expected }) {
  assert.ok(candidates[target] && bmp && expected, 'exact native Desktop fixture required')
  const info = json(join(stage, 'staging-evidence.json'))
  const audit = json(join(stage, 'archive-audit-evidence.json'))
  const acceptance = json(join(stage, 'acceptance-evidence.json'))
  assert.equal(info.target, target)
  assert.equal(info.workerSha256, candidates[target].workerSha256)
  assert.equal(info.archive.name, 'ppocrv6-small-' + target + '.tar.gz')
  assertExactStagedArchive(target, info.archive)
  assert.equal(info.distributionReady, false)
  assert.equal(info.ownerPublicationAuthorized, false)
  assert.equal(audit.identityVerified, true)
  assert.equal(audit.archiveSha256, info.archive.sha256)
  assert.equal(acceptance.archiveSha256, info.archive.sha256)
  assert.equal(acceptance.workerSha256, info.workerSha256)
  assert.equal(acceptance.realInstaller, true)
  const archive = resolve(stage, info.archive.name)
  const bytes = readFileSync(archive)
  assert.equal(bytes.length, info.archive.bytes)
  assert.equal(hash(bytes), info.archive.sha256)
  const copied = join(root, 'native-ocr-package')
  mkdirSync(copied)
  const pkg = json(join(source, 'package.json'))
  for (const name of ['package.json', ...pkg.files]) {
    const from = join(source, name), to = join(copied, name)
    assert.ok(existsSync(from), 'missing built package input ' + name)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true })
  }
  const canary = join(copied, 'lib/native-ocr-canary.js')
  const catalog = join(copied, 'lib/native-ocr-download.js')
  const mode = join(root, 'ocr-payload-mode.txt')
  const requests = join(root, 'ocr-requests.txt')
  const release = join(root, 'ocr-release.txt')
  writeFileSync(mode, 'corrupt')
  writeFileSync(requests, '')
  writeFileSync(release, '')
  const pinSource = readFileSync(canary, 'utf8')
  const old = target === 'darwin-arm64'
    ? '71d535b86b0543e7408b41ed66f45d3bea46e09e0e3f38aa491a32a60085d204'
    : '2e4b96a204c34eebe11f117049b1a3b966f43a8402a66065c28773528cd18a33'
  writeFileSync(canary, replaceOnce(pinSource, old, info.workerSha256))
  const original = readFileSync(catalog, 'utf8')
  const entry = { url: fixtureUrl(info.archive.name), bytes: info.archive.bytes, sha256: info.archive.sha256 }
  let altered = replaceOnce(original, 'APPROVED_NATIVE_OCR_ARCHIVES = Object.freeze({})',
    'APPROVED_NATIVE_OCR_ARCHIVES = Object.freeze(' + JSON.stringify({ [target]: entry }) + ')')
  // Only substitute the external HTTPS transport; the real Host route,
  // downloader (including SHA and size checks), installer and UI are unchanged.
  const fixture = `const moduleFetch = async (url, options) => {
    const fs = await import('node:fs/promises')
    const { homedir } = await import('node:os')
    if (await fs.realpath(homedir()) !== await fs.realpath(${JSON.stringify(home)}))
      throw Error('native OCR Desktop fixture refused non-isolated home')
    if (String(url) !== ${JSON.stringify(entry.url)} || options.credentials !== 'omit' || options.redirect !== 'manual')
      throw Error('native OCR Desktop fixture rejected external request')
    const mode = await fs.readFile(${JSON.stringify(mode)}, 'utf8')
    if (!['corrupt', 'good'].includes(mode)) throw Error('invalid OCR fixture mode')
    await fs.appendFile(${JSON.stringify(requests)}, mode + '\\n')
    const bytes = await fs.readFile(${JSON.stringify(archive)})
    if (mode === 'corrupt') bytes[Math.floor(bytes.length / 2)] ^= 255
    // The Renderer must observe busy and release this actual pending request.
    const deadline = Date.now() + 45000
    while (await fs.readFile(${JSON.stringify(release)}, 'utf8') !== mode) {
      if (Date.now() >= deadline) throw Error('Desktop OCR busy-state observation timed out')
      options.signal?.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
  }`
  altered = replaceOnce(altered,
    "const moduleFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined", fixture)
  writeFileSync(catalog, altered)
  const isolatedEnv = { HOME: home, USERPROFILE: home }
  if (process.platform === 'win32') {
    isolatedEnv.HOMEDRIVE = parse(home).root.replace(/[\\\\/]$/, '')
    isolatedEnv.HOMEPATH = home.slice(isolatedEnv.HOMEDRIVE.length)
  }
  const installation = join(home, '.dsh-vision-router', 'ocr', 'ppocrv6-small')
  const worker = join(installation, process.platform === 'win32' ? 'worker.exe' : 'worker')
  return { copied, isolatedEnv, info, mode, requests, release, installation, worker, bmp, expected }
}

async function waitEnabled(button) {
  await button.waitFor({ state: 'visible', timeout: 30000 })
  // Playwright trial click checks enabled/actionable without dispatching a click.
  await button.click({ trial: true, timeout: 30000 })
}

// The production settings layout assembles the actual folding plugin cards;
// do not act on the old nav/main template that gets replaced during injection.
async function openNativeOcrCard(page) {
  const card = page.locator('.vr-ia-plugin-card').filter({
    has: page.locator('.vr-ia-plugin-card-name').filter({ hasText: /^(?:本地与设备|Local & device)$/ }),
  })
  const header = card.locator('.vr-ia-plugin-card-header')
  await header.waitFor({ state: 'visible', timeout: 30000 })
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click()
  const body = card.locator('.vr-ia-plugin-card-body')
  await body.waitFor({ state: 'visible', timeout: 30000 })
  assert.equal(await header.getAttribute('aria-expanded'), 'true')
  return body
}

export async function exerciseExactDesktopOcr(page, context) {
  const { info, mode, requests, release, installation, worker, bmp, expected } = context
  const panel = await openNativeOcrCard(page)
  const download = panel.getByRole('button', { name: /下载并安装 PP-OCRv6|Download and install PP-OCRv6/ })
  const refresh = panel.getByRole('button', { name: /刷新安装状态|Refresh installation status/ })
  const remove = panel.getByRole('button', { name: /卸载 PP-OCRv6|Remove PP-OCRv6/ })
  const busy = panel.getByRole('status').filter({ hasText: /安装或卸载正在进行|Installation or removal in progress/ })
  const failed = panel.getByRole('alert').filter({ hasText: /integrity mismatch/i })
  const ready = panel.getByText(/已经安装且完整性校验通过|Installed and integrity-verified/)
  await waitEnabled(download)
  assert.equal(existsSync(installation), false)
  await download.click()
  await busy.waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await download.isDisabled(), true)
  writeFileSync(release, 'corrupt')
  await failed.waitFor({ state: 'visible', timeout: 210000 })
  assert.equal(existsSync(installation), false)
  assert.equal(readFileSync(requests, 'utf8'), 'corrupt\n')
  writeFileSync(mode, 'good')
  await refresh.click()
  await waitEnabled(download)
  await download.click()
  await busy.waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await download.isDisabled(), true)
  writeFileSync(release, 'good')
  await ready.waitFor({ state: 'visible', timeout: 210000 })
  await waitEnabled(remove)
  assert.equal(await download.isDisabled(), true)
  assert.equal(readFileSync(requests, 'utf8'), 'corrupt\ngood\n')
  assert.equal(hash(readFileSync(worker)), info.workerSha256)
  for (const [name, fact] of Object.entries(info.manifest.files)) {
    assert.match(name, /^(?:models\/)?[A-Za-z0-9._-]+$/)
    assert.ok(!name.split('/').some(x => x === '.' || x === '..'))
    const bytes = readFileSync(join(installation, name))
    assert.equal(bytes.length, fact.bytes)
    assert.equal(hash(bytes), fact.sha256)
  }
  assert.deepEqual(json(join(installation, 'MANIFEST.json')), info.manifest)
  const { encodeNativeOcrRgbFrame, runIsolatedLocalOcr } = await import(pathToFileURL(join(context.copied, 'lib/native-ocr-supervisor.js')).href)
  const { rgb, width, height } = decodeBmp(readFileSync(bmp))
  const recognized = await runIsolatedLocalOcr(encodeNativeOcrRgbFrame(rgb, width, height), {
    executable: worker, args: [join(installation, 'models')], timeoutMs: 22000,
  })
  assert.equal(recognized.engine, 'ncnn')
  assert.equal(recognized.text.replace(/\s+/g, ''), expected.replace(/\s+/g, ''))
  return recognized
}

export { OCR_TOOL_CALL_ID, OCR_PROMPT_MARKER, OCR_RENDERED_MARKER, readNativeOcrToolResult } from './native-ocr-desktop-tool-evidence.mjs'

export async function finishExactDesktopOcr(page, context, recognized, agentEvidence) {
  assert.equal(agentEvidence.engine, 'ncnn')
  const { info, installation, expected } = context
  assert.equal(agentEvidence.text.replace(/\s+/g, ''), expected.replace(/\s+/g, ''))
  assert.equal(agentEvidence.visionRequestsDuringOcr, 0)
  assert.equal(agentEvidence.toolCalls, 1)
  const panel = await openNativeOcrCard(page)
  const download = panel.getByRole('button', { name: /下载并安装 PP-OCRv6|Download and install PP-OCRv6/ })
  const remove = panel.getByRole('button', { name: /卸载 PP-OCRv6|Remove PP-OCRv6/ })
  await waitEnabled(remove)
  page.once('dialog', dialog => dialog.accept())
  await remove.click()
  await waitEnabled(download)
  assert.equal(existsSync(installation), false)
  const evidence = {
    schemaVersion: 1, target, archiveSha256: info.archive.sha256, workerSha256: info.workerSha256,
    realDesktopHost: true, realElectronRenderer: true, actualGuiClicks: true,
    injectedHttps: true, actualPublicHttps: false, realInstaller: true, realWorker: true,
    installedWorkerSupervisorOcr: true, hostAgentOcrToolVerified: true,
    agentEvidence,
    actualRecognition: recognized.text, confidence: recognized.confidence,
    phases: ['fresh-home', 'download-busy', 'corrupt-download-error', 'refresh-retry',
      'verified-install-status', 'installed-payload-readback', 'installed-worker-ocr', 'agent-vision-ocr-returned-ncnn', 'gui-uninstall'],
    distributionReady: false, ownerPublicationAuthorized: false
  }
  writeFileSync(process.env.DVR_NATIVE_OCR_DESKTOP_REPORT, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
  console.log('DVR_EXACT_DESKTOP_OCR=' + JSON.stringify(evidence))
}
