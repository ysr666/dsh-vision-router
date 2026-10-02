import { mkdir, readFile, readdir, copyFile, stat, mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SOURCE = path.join(ROOT, 'src')
const require = createRequire(import.meta.url)
const TSC = require.resolve('typescript/bin/tsc')

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
  const relative = path.relative(SOURCE, sourcePath)
  if (relative.endsWith('.d.ts')) return path.join(outputRoot, relative)
  return path.join(outputRoot, relative.endsWith('.ts') ? relative.slice(0, -3) + '.js' : relative)
}

async function copyCompiledTree(compiledRoot, outputRoot) {
  for (const compiled of await filesUnder(compiledRoot)) {
    const relative = path.relative(compiledRoot, compiled)
    const artifact = path.join(outputRoot, relative)
    await mkdir(path.dirname(artifact), { recursive: true })
    await copyFile(compiled, artifact)
  }
}

async function cleanPackageArtifacts(outputRoot) {
  if (outputRoot !== ROOT) return
  await Promise.all([
    rm(path.join(ROOT, 'entry.js'), { force: true }),
    rm(path.join(ROOT, 'index.js'), { force: true }),
    rm(path.join(ROOT, 'lib'), { recursive: true, force: true }),
  ])
}

async function buildInto(outputRoot) {
  await cleanPackageArtifacts(outputRoot)
  const sources = await filesUnder(SOURCE)

  for (const source of sources) {
    if (!source.endsWith('.js') && !source.endsWith('.d.ts')) continue
    const artifact = artifactPath(source, outputRoot)
    await mkdir(path.dirname(artifact), { recursive: true })
    await copyFile(source, artifact)
  }

  const compiledRoot = await mkdtemp(path.join(os.tmpdir(), 'dvr-tsc-'))
  try {
    const compiled = spawnSync(process.execPath, [
      TSC,
      '-p',
      'tsconfig.build.json',
      '--outDir',
      compiledRoot,
    ], {
      cwd: ROOT,
      stdio: 'inherit',
    })
    if (compiled.status !== 0) process.exit(compiled.status ?? 1)
    await copyCompiledTree(compiledRoot, outputRoot)
  } finally {
    await rm(compiledRoot, { recursive: true, force: true })
  }

  return sources.map((source) => artifactPath(source, outputRoot))
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

  if (!check) {
    const artifacts = await buildInto(outputRoot)
    const destination = outputRoot === ROOT ? 'package runtime tree' : outputRoot
    console.log(`built ${artifacts.length} runtime artifacts from src/ into ${destination}`)
    return
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'dvr-build-check-'))
  try {
    const generated = await buildInto(temporary)
    const failures = []
    for (const generatedPath of generated) {
      const relative = path.relative(temporary, generatedPath)
      const artifact = path.join(outputRoot, relative)
      if (!await sameBytes(generatedPath, artifact)) failures.push(relative)
    }
    if (failures.length > 0) {
      throw new Error(`generated runtime artifacts are stale or missing:\n${failures.map((item) => `- ${item}`).join('\n')}`)
    }
    console.log(`generated runtime artifacts are in sync (${generated.length} files)`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

await stat(SOURCE)
await main()
