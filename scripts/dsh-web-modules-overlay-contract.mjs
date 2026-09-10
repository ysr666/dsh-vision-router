import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const WEB_MODULES_ROW_ID = 'modules'
export const WEB_MODULES_PACKAGE = '@deepseek-ai/dsh-client-modules'
export const WEB_SERVER_SERVICE = 'webServer'

function result(status, reason, row, inject = []) {
  return Object.freeze({ status, reason, row, inject: Object.freeze([...inject]) })
}

export function classifyWebModulesRows(rows) {
  const list = Array.isArray(rows) ? rows : []
  const matches = list.filter((row) => row && row.id === WEB_MODULES_ROW_ID)
  if (matches.length !== 1) {
    return result(
      'dangerous-drift',
      `expected exactly one official Web ${WEB_MODULES_ROW_ID} row, found ${matches.length}`,
      matches[0],
    )
  }

  const row = matches[0]
  if (row.name !== WEB_MODULES_PACKAGE) {
    return result(
      'dangerous-drift',
      `official Web ${WEB_MODULES_ROW_ID} row changed identity to ${String(row.name)}`,
      row,
    )
  }

  if (row.inject === undefined) {
    return result('shim-required', 'official Web modules row still declares no activation dependencies', row)
  }
  if (!Array.isArray(row.inject) || row.inject.some((value) => typeof value !== 'string' || value === '')) {
    return result('dangerous-drift', 'official Web modules inject field is no longer a string array', row)
  }

  const inject = [...new Set(row.inject)]
  if (inject.includes(WEB_SERVER_SERVICE)) {
    return result(
      'retire-ready',
      inject.length === 1
        ? 'official Web modules row now owns the webServer activation dependency'
        : `official Web modules row now owns webServer plus ${inject.length - 1} additional activation dependency/dependencies`,
      row,
      inject,
    )
  }
  if (inject.length === 0) {
    return result('shim-required', 'official Web modules row still has no activation dependency', row)
  }
  return result(
    'dangerous-drift',
    `official Web modules row gained activation dependencies without webServer: ${inject.join(', ')}`,
    row,
    inject,
  )
}

export async function inspectDshWebModulesOverlay(dshRoot) {
  const root = path.resolve(dshRoot || '')
  if (!dshRoot) throw new Error('DSH_SOURCE_ROOT is required')
  const appBootUrl = pathToFileURL(path.join(root, 'packages/boot/app-boot/src/index.ts')).href
  const { loadOverlayPatches } = await import(appBootUrl)
  const patchPath = path.join(root, 'packages/bundle/web-app/cordis.patch.yml')
  const patches = loadOverlayPatches('dvr modules/webServer overlay contract', patchPath)
  const insertedRows = patches.flatMap((patch) => Array.isArray(patch?.insert) ? patch.insert : [])
  return classifyWebModulesRows(insertedRows)
}

async function main() {
  const dshRoot = String(process.env.DSH_SOURCE_ROOT || '').trim()
  const expected = String(process.env.DSH_MODULES_WEBSERVER_EXPECTED || '').trim()
  const inspected = await inspectDshWebModulesOverlay(dshRoot)
  const payload = {
    ok: inspected.status !== 'dangerous-drift' && (!expected || inspected.status === expected),
    status: inspected.status,
    expected: expected || undefined,
    reason: inspected.reason,
    inject: inspected.inject,
  }
  console.log(JSON.stringify(payload))

  if (inspected.status === 'dangerous-drift') {
    throw new Error(`DSH Web modules compatibility overlay is unsafe: ${inspected.reason}`)
  }
  if (expected && inspected.status !== expected) {
    if (inspected.status === 'retire-ready') {
      throw new Error(
        `DSH Web now owns modules -> webServer; retire DVR's compatibility overlay before admitting this Host train (${inspected.reason})`,
      )
    }
    throw new Error(`expected DSH Web modules state ${expected}, got ${inspected.status}: ${inspected.reason}`)
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invoked) await main()
