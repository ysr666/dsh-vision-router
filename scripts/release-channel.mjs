/**
 * Immutable release identity to npm/GitHub channel mapping.
 * Never silently make a prerelease the default latest release.
 */
import semver from 'semver'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export function releaseDistTag(version) {
  if (typeof version !== 'string') throw new TypeError('release version must be a string')
  const info = semver.parse(version)
  if (info === null || info.version !== version || info.build.length !== 0) {
    throw new Error('invalid or noncanonical release version')
  }
  const pre = info.prerelease
  if (pre.length === 0) return 'latest'
  if (pre.length === 2 && Number.isSafeInteger(pre[1]) && pre[1] >= 0) {
    if (pre[0] === 'rc') return 'next'
    if (pre[0] === 'alpha') return 'alpha'
  }
  throw new Error('unreviewed prerelease channel; only rc.N and alpha.N are admitted')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = process.argv[2]
    process.stdout.write(releaseDistTag(version) + '\n')
  } catch (error) {
    process.stderr.write('release channel refused: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 1
  }
}
