import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const LEGACY_DVR_SOURCE = "source: { kind: 'plugin', plugin: 'dsh-vision-router' }"

test('#606 durable DVR producers own the Session-format source instead of relying on final normalization', () => {
  const core = read('index.js')
  const providerBoundary = '        // One shared deadline for the WHOLE task:'
  const split = core.indexOf(providerBoundary)
  assert.ok(split > 0, 'provider-internal message boundary must stay explicit')
  const durableCore = core.slice(0, split)
  const providerInternal = core.slice(split)

  assert.equal(
    durableCore.includes(LEGACY_DVR_SOURCE),
    false,
    'Session-facing core producers must not author the legacy shared plugin source',
  )
  assert.equal(
    (durableCore.match(/source: visionRouterMessageSource\(session\)/g) ?? []).length,
    3,
    'bootstrap, follow-up, and auto-mount producers must stamp source from their owning Session',
  )

  // These two messages are request-local input to DVR's vision provider, not
  // Session durable messages. Keep them out of the #606 compatibility change.
  assert.equal(
    (providerInternal.match(/source: \{ kind: 'plugin', plugin: 'dsh-vision-router' \}/g) ?? []).length,
    2,
    'provider-internal request messages must remain outside the Session-source migration',
  )

  const structured = read('lib/structured-flow-hardening.js')
  assert.equal(structured.includes(LEGACY_DVR_SOURCE), false)
  assert.equal(
    (structured.match(/source: visionRouterMessageSource\(payload\?\.agent\?\.session\)/g) ?? []).length,
    2,
  )

  const evidence = read('lib/vision-evidence-guidance.js')
  assert.equal(evidence.includes(LEGACY_DVR_SOURCE), false)
  assert.match(evidence, /source: visionRouterMessageSource\(exec\.agent\.session\)/)

  const localized = read('lib/runtime-i18n-boundary.js')
  assert.equal(localized.includes("source: { kind: 'plugin', plugin: PLUGIN_NAME }"), false)
  assert.match(localized, /source: visionRouterMessageSource\(payload\?\.agent\?\.session\)/)
})
