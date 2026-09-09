import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const MAX_CI_IMPACT_INPUT_BYTES = 1024 * 1024
export const MAX_CI_IMPACT_PATHS = 5000

const matches = (path, patterns) => patterns.some((pattern) => (
  typeof pattern === 'string' ? path === pattern || path.startsWith(`${pattern}/`) : pattern.test(path)
))

const DOCS = [/^README(?:\.[^/]+)?$/i, /^docs\//, /^SECURITY\.md$/, /^LICENSE(?:\.[^/]+)?$/]
const BROWSER = [
  /^lib\/client(?:-|\.)/, /^lib\/web\//, /^lib\/settings(?:-|\.)/, /^lib\/session-affinity/,
  /^lib\/.*-client-prelude\.js$/, /^lib\/vision-model-visibility-boundary(?:-main)?\.js$/,
  'lib/guide-vision-toggle-highlight.js', 'lib/remote-settings-risk-confirmation.js',
  'lib/v2-settings-ia-integration.js', 'lib/vision-capability-benchmark-client.js',
  'lib/vision-exact-check-client.js', 'lib/vision-routing-settings-prelude.js',
  /^scripts\/.*browser.*\.mjs$/, 'scripts/dsh-preview-mixed-attachment-paste-smoke.mjs',
  /^tests\/.*(?:browser|client|settings).*\.test\.js$/,
  'tests/clipboard-image-paste-compat.test.js', 'tests/issue-367-remote-session-inject.test.js',
  /^tests\/issue-284-(?:model-visibility|vision-selection-effort)\.test\.js$/,
]
const HOST = [
  'entry.js', 'index.js', 'package.json', 'pnpm-lock.yaml', 'cordis.patch.yml',
  /^lib\/dsh-/, /^lib\/runtime-composition\.js$/, /^lib\/public-entry\.js$/,
  /^lib\/vision-provider-transport\.js$/, /^lib\/http-compat\.js$/, /^lib\/pi-ai-/,
  /^lib\/session-vision-/, /^lib\/web-capability-boundary\.js$/,
]
const WINDOWS = [
  'lib/windows-desktop-capture.js', 'lib/tesseract-exec-compat.js',
  'tests/qa-screenshot-runtime.test.js', 'tests/tesseract-node24-boot.test.js',
  '.github/workflows/adversarial-compat-hardening.yml',
]
const RESOURCE = [
  'lib/image-resource-governor.js', 'lib/pixel-diff-stream.js', 'lib/vision-artifact-store.js',
  /^lib\/artifact-/, /^tests\/large-image-resource-/, /^tests\/image-resource-governor\.test\.js$/,
  'scripts/image-resource-stress.mjs', '.github/workflows/resource-stress.yml',
]
const NATIVE = [
  'lib/native-image-coexistence.js', /^tests\/native-image-coexistence\.test\.js$/,
  /^tests\/issue-289-native-nonintervention\.test\.js$/,
]
const ROUTING_META = [
  /^\.github\//, 'package.json', 'pnpm-lock.yaml', 'scripts/ci-impact-classifier.mjs',
  /^tests\/bundle-defaults\.test\.js$/,
]

const failClosedImpact = (reason) => ({
  files: [], docsOnly: false, core: true, browser: true, host: true, windows: true, resource: true, native: true, full: true, reasons: [reason],
})

export function classifyCiImpact(paths) {
  const normalized = paths.map((value) => String(value))
  const inputBytes = normalized.reduce((total, value) => total + Buffer.byteLength(value, 'utf8') + 1, 0)
  if (normalized.length > MAX_CI_IMPACT_PATHS || inputBytes > MAX_CI_IMPACT_INPUT_BYTES) {
    return failClosedImpact('change-set exceeds classifier budget: fail closed')
  }
  const files = [...new Set(normalized)].sort()
  if (files.length === 0) return failClosedImpact('empty-change-set: fail closed')
  const unsafe = files.filter((path) => path === '' || /[\u0000-\u001f\u007f]/.test(path)
    || path.startsWith('/') || path.startsWith('./') || path === '..' || path.startsWith('../') || path.includes('/../'))
  if (unsafe.length > 0) return failClosedImpact('unsafe changed path encoding: fail closed')

  const docsOnly = files.every((path) => matches(path, DOCS))
  const result = {
    files,
    docsOnly,
    core: !docsOnly,
    browser: files.some((path) => matches(path, BROWSER)),
    host: files.some((path) => matches(path, HOST)),
    windows: files.some((path) => matches(path, WINDOWS)),
    resource: files.some((path) => matches(path, RESOURCE)),
    native: files.some((path) => matches(path, NATIVE)),
    full: false,
    reasons: [],
  }

  if (docsOnly) {
    result.reasons.push('documentation-only change')
    return result
  }

  const known = (path) => matches(path, [...DOCS, ...BROWSER, ...HOST, ...WINDOWS, ...RESOURCE, ...NATIVE, ...ROUTING_META])
  const unknown = files.filter((path) => !known(path))
  if (files.some((path) => matches(path, ROUTING_META))) result.reasons.push('CI/package routing metadata changed')
  if (unknown.length) result.reasons.push(`unclassified paths fail closed: ${unknown.join(', ')}`)
  result.full = result.reasons.length > 0
  return result
}

export function classifyCiImpactJsonLines(input) {
  const text = String(input ?? '')
  if (Buffer.byteLength(text, 'utf8') > MAX_CI_IMPACT_INPUT_BYTES) {
    return failClosedImpact('change-set input exceeds classifier budget: fail closed')
  }
  const lines = text.split(/\r?\n/).filter((line) => line !== '')
  if (lines.length > MAX_CI_IMPACT_PATHS) {
    return failClosedImpact('change-set exceeds classifier path budget: fail closed')
  }
  const paths = []
  try {
    for (const line of lines) {
      const value = JSON.parse(line)
      if (typeof value !== 'string') throw new TypeError('changed-file entry must be a JSON string')
      paths.push(value)
    }
  } catch {
    return failClosedImpact('invalid JSON-lines changed-file input: fail closed')
  }
  return classifyCiImpact(paths)
}

async function main() {
  let stdin = ''
  let inputBytes = 0
  let oversized = false
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    inputBytes += Buffer.byteLength(chunk, 'utf8')
    if (inputBytes > MAX_CI_IMPACT_INPUT_BYTES) {
      oversized = true
      break
    }
    stdin += chunk
  }
  const result = oversized
    ? failClosedImpact('change-set input exceeds classifier budget: fail closed')
    : process.argv.includes('--json-lines')
      ? classifyCiImpactJsonLines(stdin)
      : classifyCiImpact(stdin.split(/\r?\n/).filter((line) => line !== ''))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    const fs = await import('node:fs/promises')
    const flags = ['core', 'browser', 'host', 'windows', 'resource', 'native', 'full']
      .map((key) => `| ${key} | ${result[key] ? 'run' : 'skip candidate'} |`).join('\n')
    await fs.appendFile(summary, `## CI impact classifier (shadow mode)\n\nNo jobs are skipped from this result yet.\n\n| Gate | Shadow decision |\n| --- | --- |\n${flags}\n\nReasons: ${result.reasons.join('; ') || 'known scoped change'}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
