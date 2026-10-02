#!/usr/bin/env node
/**
 * Lifecycle / dynamic-boundary invariant lint.
 *
 * Every defect class the R0-R11 architecture program found traces back to a
 * boundary that ordinary behaviour tests do not exercise. This lint pins the
 * two classes that can be decided mechanically with zero false positives on
 * the current tree, so a fixed regression cannot silently return:
 *
 *   L1 sealed-process-global
 *      A process-wide global (today: `globalThis.fetch`) read at call time
 *      instead of captured once at module load. R10 proved the hard way that a
 *      "pure typing" rewrite from `globalThis.fetch.bind(globalThis)` to
 *      `(input, init) => globalThis.fetch(input, init)` silently re-admits
 *      DVR's own later-installed fetch wrappers into Router-owned provider
 *      transport. Capture is a behaviour contract, not a style choice.
 *
 *   L2 optional-capability-direct-read
 *      An optional Cordis capability read as a bare property (`ctx.attachments`).
 *      In the supported Cordis lines a context property read is the
 *      dependency-enforcing proxy path, while `Context#get()` is the
 *      explicitly non-owning probe. A bare read can materialise a hard
 *      dependency on a capability the Host may never mount, so every read must
 *      be an optional probe, a guarded probe, or an explicit inject.
 *
 * The remaining R11 defect classes (async teardown ownership, HMR generation
 * isolation, ordered mutation admission, release state-machine recovery) are
 * tracked as an explicit review checklist in
 * docs/architecture/3.0-r11-adversarial-review.md, because deciding them needs
 * the owning module's semantics rather than a pattern.
 */
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts'])

/**
 * Optional services the Host may legitimately never mount. `llm`/`tools`/`fs`/
 * `locale`/`settings` are deliberately absent: DVR declares them in its
 * `inject` lists in every supported Host line, so a bare read there is a
 * declared dependency rather than a probe. The names below are the
 * capabilities whose absence DVR must degrade gracefully around.
 */
const OPTIONAL_CAPABILITY_NAMES = [
  'attachments',
  'sessionQuery',
  'sessionProjections',
  'systemPrompt',
  'storageDomain',
  'credentials',
  'webServer',
]

/**
 * Files whose context parameters are declaration-owned, not the plugin's
 * optional-capability probe surface:
 *
 *  - `src/index.js` is the plugin entry: `ctx` there is the Host-supplied
 *    context whose `inject` list declares every dependency it reads.
 *  - `src/lib/client.js` runs inside the browser prelude against the client
 *    context the Host hands the card, so `locale`/`remote` are positional.
 *  - `src/lib/core-primitives.js` is a Core module operating on an `llm` that
 *    the surrounding Core composition already owns.
 *
 * Everything else is the surface R10 audited, where a bare read can
 * materialise a dependency the Host may never mount.
 */
const DECLARATION_OWNED_CONTEXT_FILES = new Set([
  'src/index.js',
  'src/lib/client.js',
  'src/lib/core-primitives.js',
])

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `diagnostics-lint: <rule>` on the same or the previous line exempts a site. */
function exemptionFor(lines, line) {
  const text = `${lines[line - 2] ?? ''}\n${lines[line - 1] ?? ''}`
  return /diagnostics-lint:\s*([a-z0-9-]+)/i.exec(text)?.[1]
}

async function filesUnder(directory) {
  const out = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) out.push(absolute)
    }
  }
  await walk(directory)
  return out.sort()
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/')
}

function lineOf(source, index) {
  let line = 1
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1
  return line
}

/** Blank comment and string bodies while preserving offsets and newlines. */
function maskNonCode(source) {
  const out = source.split('')
  const blank = (start, end) => {
    for (let i = start; i < end; i += 1) if (out[i] !== '\n') out[i] = ' '
  }
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    const next = source[i + 1]
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? n : end
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < n) {
        if (source[j] === '\\') {
          j += 2
          continue
        }
        if (source[j] === ch) break
        j += 1
      }
      const stop = j >= n ? n : j + 1
      blank(i + 1, stop - 1)
      i = stop
      continue
    }
    i += 1
  }
  return out.join('')
}

function depthAt(masked, index) {
  let depth = 0
  for (let i = 0; i < index; i += 1) {
    const ch = masked[i]
    if (ch === '{' || ch === '(' || ch === '[') depth += 1
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1
  }
  return depth
}

export function findViolations(source, file = '<inline>') {
  const violations = []
  const masked = maskNonCode(source)
  const lines = source.split('\n')
  const report = (rule, index, detail) => {
    const line = lineOf(masked, index)
    if (exemptionFor(lines, line) === rule.replace(/^L\d-/, '')) return
    if (exemptionFor(lines, line) === rule) return
    violations.push({ rule, file, line, detail, text: (lines[line - 1] ?? '').trim() })
  }

  // L1: call-time read of a sealed process global.
  const fetchPattern = /globalThis\s*\.\s*fetch/g
  for (const match of masked.matchAll(fetchPattern)) {
    const before = masked.slice(Math.max(0, match.index - 200), match.index)
    const after = masked.slice(match.index, Math.min(masked.length, match.index + 60))
    // Call position: `globalThis.fetch(...)` invokes whatever the global points
    // at right now. That is the defect this rule owns.
    if (/^globalThis\s*\.\s*fetch\s*\(/.test(after)) {
      report('L1-sealed-process-global', match.index, 'globalThis.fetch is invoked at call time; capture the function once at module load')
      continue
    }
    const statementStart = masked.lastIndexOf('\n', match.index) + 1
    const statement = masked.slice(statementStart, match.index)
    const depth = depthAt(masked, match.index)
    const isDefaultParameter = /(?:function\s+[\w$]*|[A-Za-z_$][\w$]*)\s*\([^)]*$/.test(before) && depth <= 1
    const isDeclaration = /(?:const|let|var)\s+[\w$]+\s*=\s*(?:typeof\s+)?$/.test(statement)
      || /^\s*(?:typeof|export)\b/.test(statement)
    const isTypePosition = /\b(?:type|interface|Parameters|typeof)\b/.test((before.split('\n').slice(-1)[0] ?? ''))
    if (isDeclaration || isTypePosition || (isDefaultParameter && depth <= 1)) continue
    if (depth !== 0) {
      report('L1-sealed-process-global', match.index, 'globalThis.fetch read inside a function body; capture it at module load instead')
    }
  }

  // L2: optional Cordis capability read through the dependency-enforcing path.
  // Callback contexts that `inject([...], cb)` already declared (webCtx,
  // childCtx, ...) and the Session/Agent contexts the Host hands DVR are
  // deliberately out of scope: reading a declared dependency is not a probe.
  if (!DECLARATION_OWNED_CONTEXT_FILES.has(file)) {
    const names = OPTIONAL_CAPABILITY_NAMES.join('|')
    const directRead = new RegExp(`(?<![\\w$.?])(?:ctx|ownerCtx|settingsCtx)\\s*\\.\\s*(${names})\\b`, 'g')
    const reportedLines = new Set()
    for (const match of masked.matchAll(directRead)) {
      const line = lineOf(masked, match.index)
      if (reportedLines.has(line)) continue
      // `typeof ctx.x !== 'undefined'` and `typeof ctx.x?.y !== 'function'`
      // are presence guards: the read itself is the probe.
      const flatLine = (lines[line - 1] ?? '').replace(/\s+/g, '')
      const access = match[0].replace(/\s+/g, '')
      const guarded = new RegExp(
        `typeof${escapeRegExp(access)}(?:\\?\\.?[\\w$]+)*(?:===?|!==?)['"](?:function|undefined|object|string|number)['"]`,
      ).test(flatLine)
      if (guarded) continue
      reportedLines.add(line)
      report('L2-optional-capability-direct-read', match.index, `bare ctx.${match[1]} read; use Context#get() as an optional probe or an explicit inject`)
    }

    // A computed read reaches the same dependency-enforcing property path as
    // `ctx.name`, so a literal-name regex is not enough: `ctx?.['attachments']`
    // and even `ctx?.[name]` bypass the rule above. Symbol-keyed reads stay
    // allowed (Host identity lookups, not capability probes).
    const computedRead = new RegExp(
      `(?<![\\w$.?])(?:ctx|ownerCtx|settingsCtx)\\s*\\??\\.?\\s*\\[\\s*([^\\]]{1,120}?)\\s*\\]`,
      'g',
    )
    for (const match of masked.matchAll(computedRead)) {
      const key = match[1].trim()
      if (/^Symbol\s*\./.test(key)) continue
      const line = lineOf(masked, match.index)
      if (reportedLines.has(line)) continue
      reportedLines.add(line)
      report(
        'L2-optional-capability-computed-read',
        match.index,
        'computed Context read; use Context#get() with a literal capability name',
      )
    }
  }

  return violations
}

export async function scanSource(root = ROOT, target = path.join(ROOT, 'src')) {
  const files = await filesUnder(target)
  const violations = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    violations.push(...findViolations(source, relative(root, file)))
  }
  return violations
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const violations = await scanSource()
  if (violations.length > 0) {
    const byRule = new Map()
    for (const violation of violations) {
      if (!byRule.has(violation.rule)) byRule.set(violation.rule, [])
      byRule.get(violation.rule).push(violation)
    }
    for (const [rule, list] of byRule) {
      console.error(`\n${rule} (${list.length})`)
      for (const item of list.slice(0, 40)) {
        console.error(`  ${item.file}:${item.line}  ${item.detail}`)
        console.error(`      ${item.text}`)
      }
      if (list.length > 40) console.error(`  ... ${list.length - 40} more`)
    }
    process.exitCode = 1
  } else {
    console.log('lifecycle invariant lint passed (L1 sealed process globals, L2 optional capability probes)')
  }
}
