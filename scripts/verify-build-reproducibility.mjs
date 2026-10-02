import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

async function manifest(directory) {
  const rows = []

  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const bytes = await readFile(absolute)
      rows.push({
        path: path.relative(directory, absolute).split(path.sep).join('/'),
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })
    }
  }

  await walk(directory)
  return rows.sort((a, b) => a.path.localeCompare(b.path))
}

function build(output) {
  const result = spawnSync(process.execPath, ['scripts/build-source-artifacts.mjs', '--out-dir', output], {
    cwd: new URL('../', import.meta.url),
    stdio: 'inherit',
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const first = await mkdtemp(path.join(os.tmpdir(), 'dvr-build-a-'))
const second = await mkdtemp(path.join(os.tmpdir(), 'dvr-build-b-'))

try {
  build(first)
  build(second)

  const [a, b] = await Promise.all([manifest(first), manifest(second)])
  const left = JSON.stringify(a)
  const right = JSON.stringify(b)
  if (left !== right) {
    throw new Error('clean builds are not reproducible: relative paths, sizes, or SHA-256 hashes differ')
  }

  console.log(`reproducible build verified (${a.length} files)`)
} finally {
  await Promise.all([
    rm(first, { recursive: true, force: true }),
    rm(second, { recursive: true, force: true }),
  ])
}
