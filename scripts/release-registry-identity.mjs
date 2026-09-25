#!/usr/bin/env node
import { appendFile } from 'node:fs/promises'

const NPM_REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const RELEASE_PACKAGE_NAME = 'dsh-vision-router'
const DEFAULT_DELAY_MS = 5_000
const DEFAULT_WAIT_ATTEMPTS = 120
const DEFAULT_PROBE_ATTEMPTS = 3

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function lookupRegistryIdentity({ packageName, version, fetchImpl = fetch }) {
  const encodedPackage = encodeURIComponent(packageName)
  let response
  try {
    response = await fetchImpl(`${NPM_REGISTRY_ORIGIN}/${encodedPackage}/${encodeURIComponent(version)}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
      cache: 'no-store',
    })
  } catch (error) {
    return { state: 'transient', detail: error?.message || String(error) }
  }
  if (response.status === 404) return { state: 'missing' }
  if (response.status >= 500 || response.status === 408 || response.status === 429) {
    return { state: 'transient', detail: `HTTP ${response.status}` }
  }
  if (!response.ok) return { state: 'fatal', detail: `HTTP ${response.status}` }
  let metadata
  try {
    metadata = await response.json()
  } catch (error) {
    return { state: 'transient', detail: `invalid registry JSON: ${error?.message || error}` }
  }
  const sha1 = typeof metadata?.dist?.shasum === 'string' ? metadata.dist.shasum.trim() : ''
  if (!sha1) return { state: 'transient', detail: 'registry response has no dist.shasum' }
  return { state: 'visible', sha1 }
}

export async function waitForRegistryIdentity({
  packageName,
  version,
  expectedSha1,
  fetchImpl = fetch,
  attempts = DEFAULT_WAIT_ATTEMPTS,
  delayMs = DEFAULT_DELAY_MS,
  sleepImpl = sleep,
  onWait = () => {},
}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await lookupRegistryIdentity({ packageName, version, fetchImpl })
    if (result.state === 'visible') {
      if (result.sha1 !== expectedSha1) {
        return { state: 'mismatch', attempt, remoteSha1: result.sha1 }
      }
      return { state: 'exact', attempt, remoteSha1: result.sha1 }
    }
    if (result.state === 'fatal') return { ...result, attempt }
    if (attempt === attempts) return { state: 'timeout', attempt, last: result }
    onWait({ attempt, attempts, result })
    await sleepImpl(delayMs)
  }
  return { state: 'timeout', attempt: attempts }
}

async function writeOutput(path, key, value) {
  if (!path) return
  await appendFile(path, `${key}=${value}\n`, 'utf8')
}

async function main(argv) {
  const [mode, version, expectedSha1] = argv
  if (!['probe', 'wait'].includes(mode) || !version || !expectedSha1 || argv.length !== 3) {
    throw new Error('usage: release-registry-identity.mjs <probe|wait> <version> <expected-sha1>')
  }
  const packageName = RELEASE_PACKAGE_NAME
  const attempts = mode === 'probe'
    ? Number(process.env.RELEASE_REGISTRY_PROBE_ATTEMPTS || DEFAULT_PROBE_ATTEMPTS)
    : Number(process.env.RELEASE_REGISTRY_WAIT_ATTEMPTS || DEFAULT_WAIT_ATTEMPTS)
  const delayMs = Number(process.env.RELEASE_REGISTRY_DELAY_MS || DEFAULT_DELAY_MS)
  const result = await waitForRegistryIdentity({
    packageName,
    version,
    expectedSha1,
    attempts,
    delayMs,
    onWait({ attempt, attempts: total, result: current }) {
      if (attempt % 12 === 0) {
        console.log(`::notice::waiting for npm registry identity (${attempt}/${total}, state=${current.state})`)
      }
    },
  })

  if (mode === 'probe' && result.state === 'timeout' && result.last?.state === 'missing') {
    await writeOutput(process.env.GITHUB_OUTPUT, 'already_published', 'false')
    console.log(`npm does not currently expose ${packageName}@${version}; publish is permitted`)
    return
  }
  if (result.state === 'exact') {
    if (mode === 'probe') await writeOutput(process.env.GITHUB_OUTPUT, 'already_published', 'true')
    console.log(`npm registry exposes the exact tarball for ${packageName}@${version} after ${result.attempt} attempt(s)`)
    return
  }
  if (result.state === 'mismatch') {
    throw new Error(`registry tarball identity mismatch: local=${expectedSha1} remote=${result.remoteSha1}`)
  }
  if (result.state === 'timeout') {
    throw new Error(`npm registry did not expose ${packageName}@${version} with a verifiable identity within ${attempts * delayMs}ms (last=${result.last?.state || 'unknown'})`)
  }
  throw new Error(`npm registry identity check failed: ${result.detail || result.state}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error?.message || error}`)
    process.exitCode = 1
  })
}
