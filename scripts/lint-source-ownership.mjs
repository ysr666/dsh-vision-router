import { readFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
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

function relative(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function artifactOf(source) {
  if (source.endsWith('.d.ts')) return source
  if (source.endsWith('.ts')) return source.slice(0, -3) + '.js'
  return source
}

const [buildConfig, hostConfig, sources] = await Promise.all([
  readFile(path.join(ROOT, 'tsconfig.build.json'), 'utf8').then(JSON.parse),
  readFile(path.join(ROOT, 'tsconfig.host.json'), 'utf8').then(JSON.parse),
  filesUnder(SOURCE),
])

const buildIncludes = new Set(buildConfig.include ?? [])
const hostIncludes = new Set(hostConfig.include ?? [])
const typedSources = sources
  .map(relative)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))

const failures = []

for (const file of typedSources) {
  if (!buildIncludes.has(file)) failures.push(`${file}: missing from tsconfig.build.json`)
  if (!hostIncludes.has(file)) failures.push(`${file}: missing from tsconfig.host.json`)
}

for (const file of buildIncludes) {
  if (!file.startsWith('src/') || !file.endsWith('.ts')) continue
  if (!typedSources.includes(file)) failures.push(`${file}: stale build TypeScript include`)
}

const outputs = new Map()
for (const file of sources.map(relative).filter((file) => /\.(?:js|ts)$/.test(file))) {
  const artifact = artifactOf(file)
  const previous = outputs.get(artifact)
  if (previous !== undefined) {
    failures.push(`${artifact}: canonical ownership collision between ${previous} and ${file}`)
  } else {
    outputs.set(artifact, file)
  }
}

const forbidden = [
  { label: '@ts-ignore', pattern: /@ts-ignore\b/ },
  { label: '@ts-nocheck', pattern: /@ts-nocheck\b/ },
  { label: 'private DSH package source import', pattern: /@deepseek-ai\/[^'"\s]+\/src\// },
  { label: 'DeepSeek Harness monorepo source import', pattern: /deepseek-harness\/packages\/[^'"\s]+\/src\// },
]

for (const absolute of sources) {
  const file = relative(absolute)
  if (!/\.(?:js|ts)$/.test(file)) continue
  const source = await readFile(absolute, 'utf8')
  for (const rule of forbidden) {
    if (rule.pattern.test(source)) failures.push(`${file}: ${rule.label}`)
  }
}

const tracked = spawnSync(
  'git',
  ['ls-files', '--', 'entry.js', 'index.js', 'lib'],
  { cwd: ROOT, encoding: 'utf8' },
)
if (tracked.status !== 0) {
  failures.push('git ls-files failed while checking generated artifact ownership')
} else if (tracked.stdout.trim() !== '') {
  failures.push(`generated package artifacts are tracked:\n${tracked.stdout.trim()}`)
}

if (failures.length > 0) {
  throw new Error(`source ownership lint failed:\n${failures.map((item) => `- ${item}`).join('\n')}`)
}

console.log(
  `source ownership lint passed (${typedSources.length} typed runtime owners; ${outputs.size} canonical package artifacts)`,
)
