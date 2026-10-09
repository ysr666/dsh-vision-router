import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const WEB_CONNECTION_ROW_ID = 'connection'
export const WEB_CONNECTION_PACKAGE = '@deepseek-ai/dsh-client-connection'
export const WEB_RUNTIME_SERVICE = 'webRuntime'
export const WEB_STARTUP_SERVICE = 'webStartup'
export const WEB_SERVER_SERVICE = 'webServer'
export const READY_SERVICE = 'visionRouterWebConnectionReady'
export const READY_ENTRY = 'vision-router-web-connection-ready'
export const READY_ENTRY_MODULE = './presets/web-connection-ready.mjs'

function result(status, reason, row, inject = [], generation) {
  return Object.freeze({ status, reason, row, inject: Object.freeze([...inject]), generation })
}

export function classifyWebConnectionRows(rows) {
  const list = Array.isArray(rows) ? rows : []
  const matches = list.filter((row) => row && row.id === WEB_CONNECTION_ROW_ID)
  if (matches.length !== 1) {
    return result('dangerous-drift',
      `expected exactly one official Web ${WEB_CONNECTION_ROW_ID} row, found ${matches.length}`,
      matches[0])
  }
  const row = matches[0]
  if (row.name !== WEB_CONNECTION_PACKAGE) {
    return result('dangerous-drift',
      `official Web ${WEB_CONNECTION_ROW_ID} row changed identity to ${String(row.name)}`, row)
  }
  if (!Array.isArray(row.inject) || row.inject.some((value) => typeof value !== 'string' || value === '')) {
    return result('dangerous-drift', 'official Web connection inject field is no longer a string array', row)
  }
  const inject = [...new Set(row.inject)]
  if (inject.includes(WEB_SERVER_SERVICE)) {
    // webServer alone does not preserve the Host's trust-generation owner.
    // Retire only when the official row also names a recognized source.
    if (!inject.includes(WEB_RUNTIME_SERVICE) && !inject.includes(WEB_STARTUP_SERVICE)) {
      return result('dangerous-drift', 'official Connection declares webServer without native trust source',
        row, inject)
    }
    return result('retire-ready', 'official Connection now injects webServer; review removal of DVR bridge',
      row, inject)
  }
  const generation = inject.length === 1 && inject[0] === WEB_RUNTIME_SERVICE
    ? 'legacy-runtime'
    : inject.length === 1 && inject[0] === WEB_STARTUP_SERVICE
      ? 'startup' : undefined
  if (!generation) {
    return result('dangerous-drift',
      `unreviewed official Web Connection dependencies: ${inject.join(', ')}`, row, inject)
  }
  // Include's patch replaces the entire config, not just trustedHosts. Reject
  // new Host-owned settings instead of silently dropping them.
  const keys = Object.keys(row.config ?? {})
  const expectedExpression = generation === 'legacy-runtime'
    ? 'ctx.webRuntime.trustedHosts'
    : 'ctx.webStartup.trustedHosts'
  const sourceExpression = row.config?.trustedHosts?.__jsExpr
  if (keys.length !== 1 || keys[0] !== 'trustedHosts'
    || sourceExpression !== expectedExpression) {
    return result('dangerous-drift', 'official Connection trust configuration changed',
      row, inject, generation)
  }
  return result('shim-required',
    `official Connection uses ${generation}; DVR readiness gate preserves this Host-owned trust list`,
    row, inject, generation)
}

export async function inspectDshWebConnectionOverlay(dshRoot) {
  const root = path.resolve(dshRoot || '')
  if (!dshRoot) throw new Error('DSH_SOURCE_ROOT is required')
  const appBootUrl = pathToFileURL(path.join(root, 'packages/boot/app-boot/src/index.ts')).href
  const profileUrl = pathToFileURL(path.join(root, 'packages/boot/app-boot/src/profile.ts')).href
  const [{ loadOverlayPatches }, { composeEntries }] = await Promise.all([
    import(appBootUrl), import(profileUrl),
  ])
  const patches = loadOverlayPatches('dvr connection/webServer overlay contract',
    path.join(root, 'packages/bundle/web-app/cordis.patch.yml'))
  const insertedRows = patches.flatMap((patch) => Array.isArray(patch?.insert) ? patch.insert : [])
  const classified = classifyWebConnectionRows(insertedRows)
  if (classified.status !== 'shim-required') return classified

  const dvrRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
  const dvrPatches = loadOverlayPatches('dvr connection/webServer overlay contract',
    path.join(dvrRoot, 'cordis.patch.yml'))
  const composed = composeEntries([patches, dvrPatches])
  const effective = composed.find((row) => row?.id === WEB_CONNECTION_ROW_ID)
  if (!effective) {
    return result('dangerous-drift', 'DVR overlay removed the official Web Connection row')
  }
  const { inject: officialInject, config: officialConfig, ...officialStable } = classified.row
  const { inject: effectiveInject, config: effectiveConfig, ...effectiveStable } = effective
  if (!isDeepStrictEqual(effectiveStable, officialStable)) {
    return result('dangerous-drift', 'DVR overlay changed official Connection fields other than inject/config',
      effective, effectiveInject, classified.generation)
  }
  if (!isDeepStrictEqual(effectiveInject, [WEB_STARTUP_SERVICE, WEB_SERVER_SERVICE, READY_SERVICE])) {
    return result('dangerous-drift', 'DVR Connection required service list drifted',
      effective, effectiveInject, classified.generation)
  }
  if (!isDeepStrictEqual(effectiveConfig,
    { trustedHosts: { __jsExpr: 'ctx.visionRouterWebConnectionReady.trustedHosts' } })) {
    return result('dangerous-drift', 'DVR must pass only the private gate Host-owned trust list',
      effective, effectiveInject, classified.generation)
  }
  if (officialConfig === undefined || Object.keys(officialConfig).length !== 1) {
    return result('dangerous-drift', 'official Connection config expanded after classification',
      effective, effectiveInject, classified.generation)
  }
  const gates = composed.filter((row) => row?.id === READY_ENTRY)
  if (gates.length !== 1 || gates[0].name !== READY_ENTRY_MODULE) {
    return result('dangerous-drift', 'private readiness bridge missing or duplicated',
      effective, effectiveInject, classified.generation)
  }
  return classified
}

async function main() {
  const dshRoot = String(process.env.DSH_SOURCE_ROOT || '').trim()
  const expected = String(process.env.DSH_CONNECTION_WEBSERVER_EXPECTED || '').trim()
  const inspected = await inspectDshWebConnectionOverlay(dshRoot)
  const payload = {
    ok: inspected.status !== 'dangerous-drift' && (!expected || inspected.status === expected),
    status: inspected.status,
    expected: expected || undefined,
    reason: inspected.reason,
    inject: inspected.inject,
    generation: inspected.generation,
  }
  console.log(JSON.stringify(payload))
  if (inspected.status === 'dangerous-drift') {
    throw new Error(`DSH Web connection compatibility overlay is unsafe: ${inspected.reason}`)
  }
  if (expected && inspected.status !== expected) {
    if (inspected.status === 'retire-ready') {
      throw new Error(`DSH Web now owns connection -> webServer; retire DVR's compatibility overlay before admitting this Host train (${inspected.reason})`)
    }
    throw new Error(`expected DSH Web connection state ${expected}, got ${inspected.status}: ${inspected.reason}`)
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invoked) await main()
