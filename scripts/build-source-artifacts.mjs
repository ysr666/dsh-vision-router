import { mkdir, readFile, readdir, copyFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SOURCE = path.join(ROOT, 'src')

async function filesUnder(directory) {
  const out = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) out.push(absolute)
    }
  }
  await walk(directory)
  return out.sort()
}

function artifactPath(sourcePath) {
  return path.join(ROOT, path.relative(SOURCE, sourcePath))
}

async function sameBytes(left, right) {
  try {
    const [a, b] = await Promise.all([readFile(left), readFile(right)])
    return a.equals(b)
  } catch {
    return false
  }
}

async function main() {
  const check = process.argv.includes('--check')
  const sources = await filesUnder(SOURCE)
  const failures = []

  for (const source of sources) {
    const artifact = artifactPath(source)
    if (check) {
      if (!await sameBytes(source, artifact)) {
        failures.push(path.relative(ROOT, artifact))
      }
      continue
    }
    await mkdir(path.dirname(artifact), { recursive: true })
    await copyFile(source, artifact)
  }

  if (check && failures.length > 0) {
    throw new Error(`generated runtime artifacts are stale or missing:\n${failures.map((item) => `- ${item}`).join('\n')}`)
  }

  if (check) {
    console.log(`source/artifact mirror is in sync (${sources.length} files)`)
  } else {
    console.log(`built ${sources.length} runtime artifacts from src/`)
  }
}

await stat(SOURCE)
await main()
