import { readFile, appendFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const RELEASE_NOTE = /^docs\/releases\/v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\.md$/

function sameExceptVersion(basePackage, headPackage) {
  const base = structuredClone(basePackage)
  const head = structuredClone(headPackage)
  delete base.version
  delete head.version
  return JSON.stringify(base) === JSON.stringify(head)
}

export function classifyHeavyHostImpact({ changedPaths, basePackage, headPackage }) {
  const paths = [...new Set(changedPaths.map(String))].sort()
  if (paths.length === 0) return { heavy: true, reason: 'empty change set: fail closed' }

  const allowed = paths.every((path) => path === 'package.json' || RELEASE_NOTE.test(path))
  if (!allowed) return { heavy: true, reason: 'Host-relevant or unclassified path changed' }

  if (!paths.includes('package.json')) {
    return { heavy: false, reason: 'curated release notes only' }
  }
  if (!basePackage || !headPackage || typeof basePackage !== 'object' || typeof headPackage !== 'object') {
    return { heavy: true, reason: 'package metadata unavailable: fail closed' }
  }
  if (basePackage.version === headPackage.version) {
    return { heavy: true, reason: 'package.json changed without a version transition: fail closed' }
  }
  if (!sameExceptVersion(basePackage, headPackage)) {
    return { heavy: true, reason: 'package.json changed beyond version' }
  }
  return { heavy: false, reason: 'release metadata only: package version + curated notes' }
}

async function main() {
  const args = process.argv.slice(2)
  const baseIndex = args.indexOf('--base-package')
  const headIndex = args.indexOf('--head-package')
  if (baseIndex < 0 || headIndex < 0 || !args[baseIndex + 1] || !args[headIndex + 1]) {
    throw new Error('usage: ci-heavy-host-impact.mjs --base-package <path> --head-package <path>')
  }

  let changed = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) changed += chunk
  const changedPaths = changed.split(/\r?\n/).filter(Boolean)
  let result
  try {
    const [baseText, headText] = await Promise.all([
      readFile(resolve(args[baseIndex + 1]), 'utf8'),
      readFile(resolve(args[headIndex + 1]), 'utf8'),
    ])
    result = classifyHeavyHostImpact({
      changedPaths,
      basePackage: JSON.parse(baseText),
      headPackage: JSON.parse(headText),
    })
  } catch (error) {
    result = { heavy: true, reason: `classifier input failure: ${error?.message || String(error)}` }
  }

  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `heavy=${result.heavy ? 'true' : 'false'}\nreason=${result.reason.replaceAll('\n', ' ')}\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
