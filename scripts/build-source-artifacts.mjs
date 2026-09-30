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

function argumentValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function artifactRoot() {
  const raw = argumentValue('--out-dir')
  return raw ? path.resolve(raw) : ROOT
}

function artifactPath(sourcePath, outputRoot) {
  return path.join(outputRoot, path.relative(SOURCE, sourcePath))
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
  const outputRoot = artifactRoot()
  const sources = await filesUnder(SOURCE)
  const failures = []

  for (const source of sources) {
    const artifact = artifactPath(source, outputRoot)
    if (check) {
      if (!await sameBytes(source, artifact)) {
        failures.push(path.relative(outputRoot, artifact))
      }
      continue
    }
    await mkdir(path.dirname(artifact), { recursive: true })
    await copyFile(source, artifact)
  }

  if (check && failures.length > 0) {
    throw new Error(`generated runtime artifacts are stale or missing:\n${failures.map((item) => `- ${item}`).join('\n')}`)
  }

  const destination = outputRoot === ROOT ? 'package runtime tree' : outputRoot
  if (check) {
    console.log(`source/artifact mirror is in sync (${sources.length} files; ${destination})`)
  } else {
    console.log(`built ${sources.length} runtime artifacts from src/ into ${destination}`)
  }
}

await stat(SOURCE)
await main()
