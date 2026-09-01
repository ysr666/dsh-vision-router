import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const REQUIRED_SEAMS = [
  'lib/dsh-contract-compat.js',
  'lib/adapter-update-coalescer.js',
  'lib/android-attachment-compat.js',
  'lib/replay-envelope-v2-compat.js',
  'lib/pi-ai-bridge-wire-compat.js',
  'lib/settings-client-rc8-lifecycle.js',
  'lib/http-compat.js',
  'lib/vision-provider-transport.js',
  'lib/legacy-global-proxy-boundary.js',
  'lib/legacy-core-vision-policy-bridge.js',
  'lib/tesseract-exec-compat.js',
  'lib/abort-signal-compat.js',
]

const REQUIRED_FIELDS = [
  'Reason',
  'Host gap',
  'Feature detection',
  'Removal condition',
  'Tests',
]

function sectionFor(inventory, seam) {
  const marker = `## \`${seam}\``
  const start = inventory.indexOf(marker)
  if (start < 0) return undefined
  const next = inventory.indexOf('\n## ', start + marker.length)
  return inventory.slice(start, next < 0 ? inventory.length : next)
}

test('every retained compatibility seam has a complete removal contract', async () => {
  const inventory = await readFile(
    new URL('../docs/architecture/compat-inventory.md', import.meta.url),
    'utf8',
  )

  for (const seam of REQUIRED_SEAMS) {
    const section = sectionFor(inventory, seam)
    assert.ok(section, `${seam} must be listed in compat-inventory.md`)
    for (const field of REQUIRED_FIELDS) {
      assert.ok(
        section.includes(`- **${field}:**`),
        `${seam} must document ${field}`,
      )
    }
  }
})

test('completed architecture phase labels do not survive as production migration instructions', async () => {
  const files = [
    '../lib/runtime-composition.js',
    '../lib/public-entry.js',
    '../lib/vision-capability-benchmark-presentation.js',
    '../lib/vision-provider-transport.js',
  ]
  const forbidden = [
    'Final P3 runtime composition boundary',
    'P3-C keeps browser/settings ownership',
    'C1 production owner',
    'C1-E keeps only',
    'P2 installs the Router-owned provider transport',
    'P2-E adds a compatibility gate',
    'C2 additive migration seam',
    'Transitional process/profile registration',
    'P3 can delete it',
  ]

  for (const path of files) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8')
    for (const phrase of forbidden) {
      assert.equal(source.includes(phrase), false, `${path} still contains stale phase text: ${phrase}`)
    }
  }
})

test('provider transport registry documents its concrete removal trigger', async () => {
  const source = await readFile(
    new URL('../lib/vision-provider-transport.js', import.meta.url),
    'utf8',
  )
  assert.match(source, /Remove it only after every production compatibility caller/)
  assert.match(source, /no production code reads\s+\*?\/?\s*currentVisionProviderTransport\(\)/s)
})
