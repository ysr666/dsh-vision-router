import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// The provider-egress family is the defect class this repository has repaired four times
// (#623 → #633 → #634 → #646). Every wave was a leg that reached a provider without the
// Router-owned transport, and every wave was found by a user rather than by CI: each repair
// added a test for that one leg, so a fifth leg could still arrive unnoticed.
//
// This guard states the class instead of a leg:
//   1. every call site of a provider primitive threads `providerTransport`, or forwards an options
//      object that cannot drop it. The check is value-shaped rather than textual, because a textual
//      one is satisfied by a token that only appears inside a string or a comment, and it treats
//      every forwarded identifier as innocent — including one the same file builds as an object
//      literal without the field. A leg that builds its own options object and forgets the field is
//      the #646 shape; a leg that omits the object entirely is the #623/#634 shape; and a leg that
//      hoists the literal into a local variable is the shape this rule closes;
//   2. a file that names a provider endpoint either references the transport or is a listed
//      exemption whose reason is re-checked against the source, so an exemption cannot rot
//      and a new egress file cannot slip in.
// Coverage boundary: this is a source contract. It proves the transport is *threaded*, not that a
// Host honors it — the per-leg runtime tests cover the behaviour. It reads values one hop deep, so
// an options object assembled across several functions is outside what it can prove, and an endpoint
// assembled from concatenated fragments is outside the endpoint pattern.
//
// A new leg now fails here with the file and line to fix, instead of in the field.

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** Provider primitives with the minimum argument count that can carry their options object. */
const PROVIDER_PRIMITIVES = new Map([
  ['callOpenAICompatible', 3],
  ['callAnthropicCompatible', 3],
  ['callLocalBackend', 3],
  ['buildInstantLocalMap', 4],
  ['createWrapperStreamBody', 2],
  ['fetchWithOpenAICompatibility', 4],
])

const OPTIONS_FORWARD = /\.\.\.\s*(?:options|params|opts|base|runtimeOptions)\b/
const TRAILING_IDENTIFIER = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*\)$/

/**
 * Files that name a provider endpoint without owning a Router egress leg, each with the
 * reason that must stay observable in the source.
 */
const ENDPOINT_EXEMPTIONS = new Map([
  [
    'src/lib/client.js',
    {
      reason: 'settings copy: the endpoint strings are UI labels, not requests',
      holds: (source) => /localFormatOpenAI:\s*'OpenAI/.test(source),
    },
  ],
  [
    'src/lib/ollama-cold-start.js',
    {
      reason: 'loopback-only warmup: isLoopbackHost gates every request',
      holds: (source) => /function isLoopbackHost\(/.test(source) && /'non-loopback'/.test(source),
    },
  ],
  [
    'src/lib/pi-ai-bridge-wire-compat.js',
    {
      reason: 'rewrites the Host pi-ai request through the captured Host fetch chain',
      holds: (source) => /captureFetchDelegate\(/.test(source) && /installFetchWrapper\(/.test(source),
    },
  ],
])

const ENDPOINT_PATTERN = /chat\/completions|\/v1\/messages|api\/v1\/chat|api\/generate|\/api\/(?:ps|tags)\b/

async function sourceFiles(directory = SRC) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sourceFiles(full))
    else if (entry.name.endsWith('.js')) files.push(full)
  }
  return files.sort()
}

function relative(file) {
  return `src/${path.relative(SRC, file).split(path.sep).join('/')}`
}

/** Blanks out comments while keeping every newline, so reported lines match the file. */
function withoutComments(source) {
  let out = ''
  let quote = null
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (quote) {
      out += char
      if (char === '\\') { out += source[i + 1] ?? ''; i += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; out += char; continue }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1 }
      out += '\n'
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += '  '
      i += 1
      continue
    }
    out += char
  }
  return out
}

/**
 * Balanced argument text of every call of `name`. Member calls (`core.callLocalBackend(...)`)
 * and spread calls (`...createWrapperStreamBody(...)`) are call sites too, so only a preceding
 * word character excludes a match.
 */
function callArguments(source, name) {
  const calls = []
  const pattern = new RegExp(`(?<![\\w$])${name}\\s*\\(`, 'g')
  for (const match of source.matchAll(pattern)) {
    if (/function\s+$/.test(source.slice(Math.max(0, match.index - 16), match.index))) continue
    const open = match.index + match[0].length - 1
    let depth = 0
    let quote = null
    for (let i = open; i < source.length; i += 1) {
      const char = source[i]
      if (quote) {
        if (char === '\\') { i += 1; continue }
        if (char === quote) quote = null
        continue
      }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue }
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) {
          calls.push({ text: source.slice(open, i + 1), index: match.index })
          break
        }
      }
    }
  }
  return calls
}

function topLevelArguments(text) {
  const inner = text.slice(1, -1)
  const parts = []
  let depth = 0
  let quote = null
  let current = ''
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]
    if (quote) {
      current += char
      if (char === '\\') { current += inner[i + 1] ?? ''; i += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; current += char; continue }
    if ('([{'.includes(char)) depth += 1
    if (')]}'.includes(char)) depth -= 1
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue }
    current += char
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

/** Drops string bodies, so a token quoted inside a literal cannot claim to be a threaded value. */
function withoutStrings(text) {
  return text.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''")
}

/**
 * Balanced text of a same-file object literal assigned to `identifier`, if the file declares one.
 * A null result means the identifier comes from elsewhere — a parameter, a destructured value or an
 * import — so threading happens at the caller and this site only forwards it.
 */
function localObjectLiteral(source, identifier) {
  const declaration = new RegExp(`(?:const|let|var)\\s+${identifier}\\s*=\\s*\\{`).exec(source)
  if (!declaration) return null
  const start = source.indexOf('{', declaration.index)
  let depth = 0
  let quote = null
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (quote) {
      if (char === '\\') { i += 1; continue }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

const FILES = await sourceFiles()
const SOURCES = new Map(await Promise.all(FILES.map(async (file) => [file, await readFile(file, 'utf8')])))
const CODE = new Map([...SOURCES].map(([file, source]) => [file, withoutComments(source)]))

test('the provider primitives this guard tracks are still defined in the source', () => {
  const missing = [...PROVIDER_PRIMITIVES.keys()].filter((name) => (
    ![...CODE.values()].some((code) => new RegExp(`function\\s+${name}\\s*\\(`).test(code))
  ))
  assert.deepEqual(
    missing,
    [],
    'a tracked provider primitive disappeared: rename or remove it here so the guard keeps guarding',
  )
})

test('every provider primitive call site threads the Router-owned transport', () => {
  const violations = []
  for (const [file, code] of CODE) {
    for (const [name, minimumArguments] of PROVIDER_PRIMITIVES) {
      for (const call of callArguments(code, name)) {
        const args = topLevelArguments(call.text)
        // The transport must appear as a value: a token inside a string literal is not one.
        const values = withoutStrings(call.text)
        const threaded = values.includes('providerTransport') || OPTIONS_FORWARD.test(values)
        // A forwarded identifier counts only when it cannot be a locally built object literal that
        // drops the field; when the file declares one, that literal has to carry the transport.
        const forwardedTo = args.length >= minimumArguments && TRAILING_IDENTIFIER.test(call.text)
          ? args[args.length - 1]
          : null
        const local = forwardedTo === null ? null : localObjectLiteral(code, forwardedTo)
        const forwards = forwardedTo !== null && (local === null || withoutStrings(local).includes('providerTransport'))
        if (threaded || forwards) continue
        const where = `${relative(file)}:${lineOf(code, call.index)}`
        violations.push(
          args.length < minimumArguments
            ? `${where} ${name}(...) passes ${args.length} arguments: its options object is missing entirely`
            : local === null
              ? `${where} ${name}(...) builds an options object without providerTransport`
              : `${where} ${name}(...) forwards the locally built '${forwardedTo}' without providerTransport`,
        )
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'provider legs must thread providerTransport: drop it and that leg bypasses proxy/proxyHosts',
  )
})

test('a file that names a provider endpoint references the transport or is an observable exemption', () => {
  const unlisted = []
  const stale = []
  for (const [file, source] of SOURCES) {
    const id = relative(file)
    if (!ENDPOINT_PATTERN.test(source)) {
      if (ENDPOINT_EXEMPTIONS.has(id)) stale.push(`${id} no longer names a provider endpoint`)
      continue
    }
    const exemption = ENDPOINT_EXEMPTIONS.get(id)
    if (!exemption) {
      if (!source.includes('providerTransport')) unlisted.push(id)
      continue
    }
    if (!exemption.holds(source)) stale.push(`${id} exemption no longer holds (${exemption.reason})`)
  }
  assert.deepEqual(unlisted, [], 'provider endpoints must be reached through the transport, or exempted here')
  assert.deepEqual(stale, [], 'exemptions must be removed once they stop describing the source')
})
