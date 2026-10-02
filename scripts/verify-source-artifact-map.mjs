import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
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

function slash(value) {
  return value.split(path.sep).join('/')
}

function artifactPathFor(sourcePath) {
  const relative = slash(path.relative(SOURCE, sourcePath))
  if (relative.endsWith('.d.ts')) return relative
  if (relative.endsWith('.ts')) return relative.slice(0, -3) + '.js'
  return relative
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

const sources = (await filesUnder(SOURCE))
  .filter((file) => file.endsWith('.js') || file.endsWith('.ts'))
const expected = new Map()
const evidence = []
const failures = []

for (const source of sources) {
  const sourceRelative = slash(path.relative(ROOT, source))
  const artifactRelative = artifactPathFor(source)
  if (expected.has(artifactRelative)) {
    failures.push(
      `${artifactRelative}: duplicate canonical owners ${expected.get(artifactRelative)} and ${sourceRelative}`,
    )
    continue
  }
  expected.set(artifactRelative, sourceRelative)

  // Read both files once instead of stat()-then-read: the previous shape was a
  // check-then-use pair (a file could disappear between the two calls), and it
  // made the verifier report a *stale* artifact identity on a race. A missing
  // artifact is still reported as such; any other read error keeps propagating.
  const artifact = path.join(ROOT, artifactRelative)
  const [sourceResult, artifactResult] = await Promise.all([
    readFile(source).then((bytes) => ({ bytes }), (error) => ({ error })),
    readFile(artifact).then((bytes) => ({ bytes }), (error) => ({ error })),
  ])
  if (artifactResult.error) {
    if (artifactResult.error.code !== 'ENOENT') throw artifactResult.error
    failures.push(`${sourceRelative}: missing package artifact ${artifactRelative}`)
    continue
  }
  if (sourceResult.error) throw sourceResult.error
  const sourceBytes = sourceResult.bytes
  const artifactBytes = artifactResult.bytes

  if (
    (sourceRelative.endsWith('.js') || sourceRelative.endsWith('.d.ts'))
    && !sourceBytes.equals(artifactBytes)
  ) {
    failures.push(`${sourceRelative}: copied artifact differs from canonical source`)
  }

  evidence.push(
    `${sourceRelative}\t${sha256(sourceBytes)}\t${artifactRelative}\t${sha256(artifactBytes)}`,
  )
}

const actual = new Set()
for (const rootFile of ['entry.js', 'index.js']) {
  try {
    await stat(path.join(ROOT, rootFile))
    actual.add(rootFile)
  } catch {}
}
try {
  for (const file of await filesUnder(path.join(ROOT, 'lib'))) {
    actual.add(slash(path.relative(ROOT, file)))
  }
} catch {}

for (const artifact of actual) {
  if (!expected.has(artifact)) failures.push(`${artifact}: orphan generated package artifact`)
}
for (const artifact of expected.keys()) {
  if (!actual.has(artifact)) failures.push(`${artifact}: expected package artifact is absent`)
}

if (failures.length > 0) {
  throw new Error(`source-to-artifact evidence failed:\n${failures.map((item) => `- ${item}`).join('\n')}`)
}

evidence.sort()
const digest = sha256(Buffer.from(evidence.join('\n') + '\n'))
const typed = sources.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts')).length
const declarations = sources.filter((file) => file.endsWith('.d.ts')).length
console.log(JSON.stringify({
  canonicalSources: sources.length,
  typedSources: typed,
  declarationSources: declarations,
  packageArtifacts: actual.size,
  mappingSha256: digest,
}, null, 2))
