import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const WEB_CONNECTION_ROW_ID = 'connection'
export const WEB_CONNECTION_PACKAGE = '@deepseek-ai/dsh-client-connection'
export const WEB_STARTUP_SERVICE = 'webStartup'
export const RETIRED_READY_SERVICE = 'visionRouterWebConnectionReady'
export const RETIRED_READY_ENTRY = 'vision-router-web-connection-ready'

function result(status, reason, row, inject = []) {
  return Object.freeze({ status, reason, row, inject: Object.freeze([...inject]) })
}

/** Exact-source guard for the new DSH 0.2.1-rc.5+ support floor. */
export function classifyWebConnectionRows(rows) {
  const matches = (Array.isArray(rows) ? rows : []).filter((row) => row?.id === WEB_CONNECTION_ROW_ID)
  if (matches.length !== 1) {
    return result('dangerous-drift', `expected one official Connection row, found ${matches.length}`)
  }
  const row = matches[0]
  if (row.name !== WEB_CONNECTION_PACKAGE) {
    return result('dangerous-drift', 'official Connection package identity changed', row)
  }
  if (!Array.isArray(row.inject) || row.inject.some((name) => typeof name !== 'string' || !name)) {
    return result('dangerous-drift', 'official Connection injection set is invalid', row)
  }
  const inject = [...new Set(row.inject)]
  if (inject.includes('webRuntime')) {
    return result('retired-host', 'legacy webRuntime Host is below the DVR 3.2 floor', row, inject)
  }
  if (!inject.includes(WEB_STARTUP_SERVICE) ||
      inject.some((name) => name !== 'webStartup' && name !== 'webServer')) {
    return result('dangerous-drift', 'unreviewed Connection injection dependencies', row, inject)
  }
  const config = row.config
  if (!config || Object.keys(config).length !== 1 ||
      config.trustedHosts?.__jsExpr !== 'ctx.webStartup.trustedHosts') {
    return result('dangerous-drift', 'official Connection trusted-host ownership changed', row, inject)
  }
  return result('native-connection', 'official Host owns Connection lifecycle and trust', row, inject)
}

export async function inspectDshWebConnectionOverlay(dshRoot) {
  if (!dshRoot) throw new Error('DSH_SOURCE_ROOT is required')
  const root = path.resolve(dshRoot)
  const appBootUrl = pathToFileURL(path.join(root, 'packages/boot/app-boot/src/index.ts')).href
  const profileUrl = pathToFileURL(path.join(root, 'packages/boot/app-boot/src/profile.ts')).href
  const [{ loadOverlayPatches }, { composeEntries }] = await Promise.all([
    import(appBootUrl), import(profileUrl),
  ])
  const patches = loadOverlayPatches('DSH native Connection contract',
    path.join(root, 'packages/bundle/web-app/cordis.patch.yml'))
  const officialRows = patches.flatMap((item) => Array.isArray(item?.insert) ? item.insert : [])
  const classified = classifyWebConnectionRows(officialRows)
  if (classified.status !== 'native-connection') return classified

  const dvrRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
  const dvrPatches = loadOverlayPatches('DVR Connection retirement contract',
    path.join(dvrRoot, 'cordis.patch.yml'))
  const flattened = dvrPatches.flatMap((item) => [
    item,
    ...(Array.isArray(item?.insert) ? item.insert : []),
  ])
  if (flattened.some((item) => item?.id === WEB_CONNECTION_ROW_ID ||
      item?.id === RETIRED_READY_ENTRY || item?.name === RETIRED_READY_ENTRY ||
      item?.inject?.includes?.(RETIRED_READY_SERVICE))) {
    return result('dangerous-drift', 'DVR resurrected a retired Connection/ready-bridge overlay')
  }

  const composed = composeEntries([patches, dvrPatches])
  const matches = composed.filter((item) => item?.id === WEB_CONNECTION_ROW_ID)
  if (matches.length !== 1 || !isDeepStrictEqual(matches[0], classified.row)) {
    return result('dangerous-drift', 'DVR changed the official Connection row after composition')
  }
  if (composed.some((item) => item?.id === RETIRED_READY_ENTRY)) {
    return result('dangerous-drift', 'retired readiness bridge still present')
  }
  return classified
}

async function main() {
  const inspected = await inspectDshWebConnectionOverlay(process.env.DSH_SOURCE_ROOT)
  const expected = String(process.env.DSH_CONNECTION_NATIVE_EXPECTED ||
    process.env.DSH_CONNECTION_WEBSERVER_EXPECTED || '').trim()
  const payload = {
    ok: inspected.status === 'native-connection' && (!expected || inspected.status === expected),
    status: inspected.status, expected: expected || undefined,
    reason: inspected.reason, inject: inspected.inject,
  }
  console.log(JSON.stringify(payload))
  if (!payload.ok) {
    throw new Error(`DSH Connection Host retirement gate: ${inspected.reason}`)
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) ===
  path.resolve(fileURLToPath(import.meta.url))
if (invoked) await main()
