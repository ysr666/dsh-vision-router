/**
 * Immutable release identity to npm/GitHub channel mapping.
 * This module intentionally has no package imports: the privileged publish job
 * checks the channel after a fresh checkout without installing dependencies.
 * Never silently make a prerelease the default latest release.
 */
import { fileURLToPath } from 'node:url'
import { existsSync, realpathSync } from 'node:fs'

const CANONICAL_REVIEWED_RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(rc|alpha)\.(0|[1-9]\d*))?$/

export function releaseDistTag(version) {
  if (typeof version !== 'string') throw new TypeError('release version must be a string')
  const match = CANONICAL_REVIEWED_RELEASE.exec(version)
  if (match === null || [match[1], match[2], match[3], match[5]]
    .filter((part) => part !== undefined)
    .some((part) => !Number.isSafeInteger(Number(part)))) {
    throw new Error('invalid, noncanonical, or unreviewed release version')
  }
  if (match[4] === undefined) return 'latest'
  return match[4] === 'rc' ? 'next' : 'alpha'
}

// macOS maps /tmp to /private/tmp: lexical argv vs import.meta.url equality
// silently skipped the actual CLI command (exit 0, empty dist-tag). Compare
// canonical file identities instead; keep library imports side-effect-free.
if (process.argv[1] && existsSync(process.argv[1]) &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const version = process.argv[2]
    process.stdout.write(releaseDistTag(version) + '\n')
  } catch (error) {
    process.stderr.write('release channel refused: ' + (error instanceof Error ? error.message : String(error)) + '\n')
    process.exitCode = 1
  }
}
