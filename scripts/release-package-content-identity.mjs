#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const TAR_LIST_BUFFER = 16 * 1024 * 1024
const TAR_FILE_BUFFER = 32 * 1024 * 1024

function safeTarEntry(name) {
  if (typeof name !== 'string' || name === '' || path.posix.isAbsolute(name)) return false
  const directory = name.endsWith('/')
  const raw = directory ? name.slice(0, -1) : name
  if (raw === '') return false
  const normalized = path.posix.normalize(raw)
  if (normalized !== raw) return false
  return normalized === 'package' || normalized.startsWith('package/')
}

async function archiveEntries(tarball) {
  const [{ stdout: namesText }, { stdout: verboseText }] = await Promise.all([
    execFileAsync('tar', ['-tzf', tarball], { maxBuffer: TAR_LIST_BUFFER }),
    execFileAsync('tar', ['-tvzf', tarball], { maxBuffer: TAR_LIST_BUFFER }),
  ])
  const names = namesText.split('\n').filter(Boolean)
  const verbose = verboseText.split('\n').filter(Boolean)
  if (names.length === 0 || names.length !== verbose.length) {
    throw new Error(`unreadable or empty npm tarball: ${tarball}`)
  }
  const seen = new Set()
  return names.map((name, index) => {
    if (!safeTarEntry(name) || seen.has(name)) {
      throw new Error(`unsafe or duplicate npm tar entry: ${name}`)
    }
    seen.add(name)
    const type = verbose[index]?.[0]
    if (type !== '-' && type !== 'd') {
      throw new Error(`unsupported npm tar entry type ${String(type)}: ${name}`)
    }
    if (type === 'd' && !name.endsWith('/')) {
      throw new Error(`directory tar entry lacks trailing slash: ${name}`)
    }
    if (type === '-' && name.endsWith('/')) {
      throw new Error(`file tar entry has directory shape: ${name}`)
    }
    return { name, type }
  })
}

async function digestArchiveFile(tarball, name) {
  const { stdout } = await execFileAsync(
    'tar',
    ['-xOzf', tarball, name],
    { encoding: 'buffer', maxBuffer: TAR_FILE_BUFFER },
  )
  return createHash('sha256').update(stdout).digest('hex')
}
async function packageManifest(tarball) {
  const entries = await archiveEntries(tarball)
  const files = []
  for (const entry of entries) {
    if (entry.type === 'd') continue
    files.push({
      path: entry.name.slice('package/'.length),
      kind: 'file',
      sha256: await digestArchiveFile(tarball, entry.name),
    })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  return files
}

export async function comparePackageTarballs(left, right) {
  const [leftManifest, rightManifest] = await Promise.all([
    packageManifest(left),
    packageManifest(right),
  ])
  return {
    exact: JSON.stringify(leftManifest) === JSON.stringify(rightManifest),
    leftManifest,
    rightManifest,
  }
}
async function main(argv) {
  if (argv.length !== 2) {
    throw new Error('usage: release-package-content-identity.mjs <fresh.tgz> <registry.tgz>')
  }
  const result = await comparePackageTarballs(argv[0], argv[1])
  if (!result.exact) {
    const left = new Map(result.leftManifest.map((entry) => [entry.path, entry]))
    const right = new Map(result.rightManifest.map((entry) => [entry.path, entry]))
    const paths = [...new Set([...left.keys(), ...right.keys()])].sort()
    const changed = paths.filter((name) => JSON.stringify(left.get(name)) !== JSON.stringify(right.get(name)))
    throw new Error(`package file-tree identity mismatch: ${changed.slice(0, 20).join(', ')}`)
  }
  console.log(JSON.stringify({ ok: true, files: result.leftManifest.length }))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error?.message || error}`)
    process.exitCode = 1
  })
}
