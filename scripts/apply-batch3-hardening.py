from pathlib import Path
import re


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


def regex_once(text, pattern, replacement, label):
    result, count = re.subn(pattern, replacement, text, count=1, flags=re.S | re.M)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one regex match, found {count}')
    return result


# ---------------------------------------------------------------------------
# index.js: bounded parsing/cache keys/cache bytes/HTTP reads/artifact writes.
# ---------------------------------------------------------------------------
path = 'index.js'
text = read(path)
text = replace_once(
    text,
    "import { createSessionVisionStateStore } from './lib/session-vision-state.js'\n",
    "import { createSessionVisionStateStore } from './lib/session-vision-state.js'\n"
    "import {\n"
    "  ERROR_RESPONSE_MAX_BYTES,\n"
    "  METADATA_RESPONSE_MAX_BYTES,\n"
    "  MODEL_RESPONSE_MAX_BYTES,\n"
    "  readResponseJsonBounded,\n"
    "  readResponseTextBounded,\n"
    "} from './lib/http-body-limit.js'\n"
    "import { writeArtifactFile } from './lib/artifact-boundary.js'\n",
    'index imports',
)

old = '''/** Extract a JSON object/array from model output (tolerates fences and prose). */
export function extractJson(text) {
  const source = String(text ?? '')
  const fenced = source.match(/```(?:json)?\\s*([\\s\\S]*?)```/i)
  const candidate = fenced ? fenced[1] : source
  const start = candidate.search(/[[{]/)
  if (start === -1) return undefined
  const trimmed = candidate.slice(start)
  for (let end = trimmed.length; end > 0; end--) {
    try {
      const value = JSON.parse(trimmed.slice(0, end))
      if (typeof value === 'object' && value !== null) return value
    } catch {
      /* keep shrinking */
    }
  }
  return undefined
}

/** Tiny LRU cache with TTL; keys are opaque strings. */
export function createCache(maxEntries, ttlMs) {
  const entries = new Map()
  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key)
        return undefined
      }
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value) {
      if (entries.has(key)) entries.delete(key)
      entries.set(key, { value, expiresAt: ttlMs <= 0 ? Infinity : Date.now() + ttlMs })
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        entries.delete(oldest)
      }
    },
    get size() {
      return entries.size
    },
  }
}

/** True when the harness llm service has a registered adapter for the provider route. */
export function adapterAvailable(llm, provider) {
'''
new = '''export const MAX_EXTRACT_JSON_CHARS = 1024 * 1024

/**
 * Extract the first complete JSON object/array from model output in one scan.
 * The previous implementation retried JSON.parse after removing one trailing
 * character at a time, turning malformed/trailed output into quadratic CPU
 * and allocation work. This scanner tracks nesting/strings once and parses at
 * most one balanced candidate.
 */
export function extractJson(text) {
  const source = String(text ?? '')
  const bounded = source.length > MAX_EXTRACT_JSON_CHARS
    ? source.slice(0, MAX_EXTRACT_JSON_CHARS)
    : source
  const fenced = bounded.match(/```(?:json)?\\s*([\\s\\S]*?)```/i)
  const candidate = fenced ? fenced[1] : bounded
  const start = candidate.search(/[[{]/)
  if (start === -1) return undefined

  const stack = []
  let inString = false
  let escaped = false
  for (let index = start; index < candidate.length; index++) {
    const char = candidate[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') stack.push('}')
    else if (char === '[') stack.push(']')
    else if (char === '}' || char === ']') {
      if (stack.length === 0 || stack.pop() !== char) return undefined
      if (stack.length === 0) {
        try {
          const value = JSON.parse(candidate.slice(start, index + 1))
          return typeof value === 'object' && value !== null ? value : undefined
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

function cacheWeight(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.byteLength
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  try {
    const encoded = JSON.stringify(value)
    return Buffer.byteLength(encoded === undefined ? String(value) : encoded, 'utf8')
  } catch {
    return Buffer.byteLength(String(value), 'utf8')
  }
}

/** LRU+TTL cache bounded by BOTH entry count and retained bytes. */
export function createCache(maxEntries, ttlMs, options = {}) {
  const entries = new Map()
  const entryLimit = Math.max(0, Math.floor(Number(maxEntries) || 0))
  const maxBytes = Number.isFinite(Number(options.maxBytes)) && Number(options.maxBytes) >= 0
    ? Math.floor(Number(options.maxBytes))
    : 8 * 1024 * 1024
  const maxEntryBytes = Number.isFinite(Number(options.maxEntryBytes)) && Number(options.maxEntryBytes) >= 0
    ? Math.floor(Number(options.maxEntryBytes))
    : Math.min(maxBytes, 1024 * 1024)
  let retainedBytes = 0

  const remove = (key) => {
    const entry = entries.get(key)
    if (!entry) return
    retainedBytes = Math.max(0, retainedBytes - entry.weight)
    entries.delete(key)
  }
  const evict = () => {
    while (entries.size > entryLimit || retainedBytes > maxBytes) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      remove(oldest)
    }
  }

  return {
    get(key) {
      const entry = entries.get(key)
      if (!entry) return undefined
      if (entry.expiresAt <= Date.now()) {
        remove(key)
        return undefined
      }
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value) {
      const normalizedKey = String(key)
      const weight = Buffer.byteLength(normalizedKey, 'utf8') + cacheWeight(value)
      remove(normalizedKey)
      if (entryLimit === 0 || maxBytes === 0 || weight > maxEntryBytes || weight > maxBytes) return false
      entries.set(normalizedKey, {
        value,
        weight,
        expiresAt: ttlMs <= 0 ? Infinity : Date.now() + ttlMs,
      })
      retainedBytes += weight
      evict()
      return entries.has(normalizedKey)
    },
    get size() {
      return entries.size
    },
    get bytes() {
      return retainedBytes
    },
  }
}

/** True when the harness llm service has a registered adapter for the provider route. */
export function adapterAvailable(llm, provider) {
'''
text = replace_once(text, old, new, 'extractJson/createCache')

old = '''/** Stable cache key for vision_describe answers: chains + content + question + mode. */
export function cacheKeyFor({ pairs, httpProviders, contentIds, wantJson, question }) {
  const chains = [
    ...(pairs ?? []).map((pair) => `${pair.provider}:${pair.model}`),
    ...(httpProviders ?? []).map((provider) => `http:${provider.name}/${provider.model}`),
  ]
  return `${chains.join(',')}|${[...(contentIds ?? [])].sort().join(',')}|${wantJson ? 'json' : 'text'}|${question}`
}
'''
new = '''/** Stable fixed-size cache key: user prompts are hashed, never retained verbatim as Map keys. */
export function cacheKeyFor({ pairs, httpProviders, contentIds, wantJson, question }) {
  const chains = [
    ...(pairs ?? []).map((pair) => `${pair.provider}:${pair.model}`),
    ...(httpProviders ?? []).map((provider) => `http:${provider.name}/${provider.model}`),
  ]
  const payload = JSON.stringify({
    chains,
    contentIds: [...(contentIds ?? [])].sort(),
    mode: wantJson ? 'json' : 'text',
    question: String(question ?? ''),
  })
  return `v2:${createHash('sha256').update(payload).digest('hex')}`
}
'''
text = replace_once(text, old, new, 'cacheKeyFor')

text = replace_once(
    text,
    "    const detail = (await response.text().catch(() => '')).slice(0, 300)\n",
    "    const detail = (await readResponseTextBounded(\n"
    "      response,\n"
    "      ERROR_RESPONSE_MAX_BYTES,\n"
    "      { label: `http provider \\\"${provider.name}\\\" error response` },\n"
    "    ).catch(() => '')).slice(0, 300)\n",
    'OpenAI bounded error body',
)
text = replace_once(
    text,
    "  const data = await response.json()\n  const content = data && data.choices && data.choices[0] && data.choices[0].message\n",
    "  const data = await readResponseJsonBounded(\n"
    "    response,\n"
    "    MODEL_RESPONSE_MAX_BYTES,\n"
    "    { label: `http provider \\\"${provider.name}\\\" response` },\n"
    "  )\n  const content = data && data.choices && data.choices[0] && data.choices[0].message\n",
    'OpenAI bounded success body',
)
text = replace_once(
    text,
    '''  const cache = createCache(
    Number.isFinite(config.cacheMaxEntries) ? config.cacheMaxEntries : 200,
    (Number.isFinite(config.cacheTtlSeconds) ? config.cacheTtlSeconds : 3600) * 1000,
  )
''',
    '''  const cache = createCache(
    Number.isFinite(config.cacheMaxEntries) ? config.cacheMaxEntries : 200,
    (Number.isFinite(config.cacheTtlSeconds) ? config.cacheTtlSeconds : 3600) * 1000,
    { maxBytes: 8 * 1024 * 1024, maxEntryBytes: 1024 * 1024 },
  )
''',
    'runtime cache byte budget',
)
text = replace_once(
    text,
    '''    const saveArtifact = async (exec, relPath, data) => {
      const dir = path.join(workspaceOf(exec), artifactsRel)
      await mkdir(dir, { recursive: true })
      const target = path.join(dir, relPath)
      await writeFile(target, data)
      return target
    }
''',
    '''    const saveArtifact = async (exec, relPath, data) =>
      writeArtifactFile(workspaceOf(exec), artifactsRel, relPath, data)
''',
    'core artifact writer',
)
text = replace_once(
    text,
    '''        const stem = artifactStem(args.image, 'ocr')
        const dir = path.join(workspaceOf(exec), artifactsRel, stem)
        await mkdir(dir, { recursive: true })
''',
    '''        const stem = artifactStem(args.image, 'ocr')
        const workspace = workspaceOf(exec)
''',
    'long OCR directory',
)
text = replace_once(
    text,
    "          const chunkRel = `chunk-${String(i + 1).padStart(2, '0')}.png`\n          await writeFile(path.join(dir, chunkRel), chunk)\n",
    "          const chunkRel = `chunk-${String(i + 1).padStart(2, '0')}.png`\n"
    "          await writeArtifactFile(workspace, artifactsRel, path.join(stem, chunkRel), chunk)\n",
    'long OCR chunk write',
)
text = replace_once(
    text,
    '''        const manifestPath = path.join(dir, 'manifest.json')
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
        const mdPath = path.join(dir, 'ocr.md')
        await writeFile(mdPath, joined)
''',
    '''        const manifestPath = await writeArtifactFile(
          workspace,
          artifactsRel,
          path.join(stem, 'manifest.json'),
          JSON.stringify(manifest, null, 2),
        )
        const mdPath = await writeArtifactFile(workspace, artifactsRel, path.join(stem, 'ocr.md'), joined)
        const dir = path.dirname(mdPath)
''',
    'long OCR manifest write',
)
text = replace_once(
    text,
    "            const data = await response.json().catch(() => undefined)\n            const models = data && Array.isArray(data.data) ? data.data : undefined\n",
    "            const data = await readResponseJsonBounded(\n"
    "              response,\n"
    "              METADATA_RESPONSE_MAX_BYTES,\n"
    "              { label: 'vision backend /models response' },\n"
    "            ).catch(() => undefined)\n"
    "            const models = data && Array.isArray(data.data) ? data.data : undefined\n",
    'bounded /models probe',
)
write(path, text)


# ---------------------------------------------------------------------------
# catalog-corrections.js: both error and success bodies are admission-bounded.
# ---------------------------------------------------------------------------
path = 'lib/catalog-corrections.js'
text = read(path)
text = replace_once(
    text,
    "import { kindForHttpStatus } from './vision-resilience.js'\n",
    "import { kindForHttpStatus } from './vision-resilience.js'\n"
    "import {\n"
    "  ERROR_RESPONSE_MAX_BYTES,\n"
    "  MODEL_RESPONSE_MAX_BYTES,\n"
    "  readResponseJsonBounded,\n"
    "  readResponseTextBounded,\n"
    "} from './http-body-limit.js'\n",
    'catalog bounded reader import',
)
text = replace_once(
    text,
    "    const detail = (await response.text().catch(() => '')).slice(0, 300)\n",
    "    const detail = (await readResponseTextBounded(\n"
    "      response,\n"
    "      ERROR_RESPONSE_MAX_BYTES,\n"
    "      { label: `anthropic provider \\\"${provider.name}\\\" error response` },\n"
    "    ).catch(() => '')).slice(0, 300)\n",
    'Anthropic bounded error body',
)
text = replace_once(
    text,
    "  const data = await response.json()\n  const blocks = Array.isArray(data && data.content) ? data.content : []\n",
    "  const data = await readResponseJsonBounded(\n"
    "    response,\n"
    "    MODEL_RESPONSE_MAX_BYTES,\n"
    "    { label: `anthropic provider \\\"${provider.name}\\\" response` },\n"
    "  )\n  const blocks = Array.isArray(data && data.content) ? data.content : []\n",
    'Anthropic bounded success body',
)
write(path, text)


# ---------------------------------------------------------------------------
# update-check.js: registry/release metadata are tiny by contract, cap them.
# ---------------------------------------------------------------------------
path = 'lib/update-check.js'
text = read(path)
text = replace_once(
    text,
    "import { createRequire } from 'node:module'\n",
    "import { createRequire } from 'node:module'\n"
    "import { METADATA_RESPONSE_MAX_BYTES, readResponseJsonBounded } from './http-body-limit.js'\n",
    'update checker bounded reader import',
)
text = replace_once(
    text,
    "  const body = await response.json().catch(() => undefined)\n  const latestVersion = body && typeof body.version === 'string' ? body.version.trim() : ''\n",
    "  const body = await readResponseJsonBounded(\n"
    "    response,\n"
    "    METADATA_RESPONSE_MAX_BYTES,\n"
    "    { label: 'update registry metadata' },\n"
    "  ).catch(() => undefined)\n"
    "  const latestVersion = body && typeof body.version === 'string' ? body.version.trim() : ''\n",
    'npm metadata body',
)
text = replace_once(
    text,
    "  const body = await response.json().catch(() => undefined)\n  const tag = body && typeof body.tag_name === 'string' ? body.tag_name.trim() : ''\n",
    "  const body = await readResponseJsonBounded(\n"
    "    response,\n"
    "    METADATA_RESPONSE_MAX_BYTES,\n"
    "    { label: 'GitHub release metadata' },\n"
    "  ).catch(() => undefined)\n"
    "  const tag = body && typeof body.tag_name === 'string' ? body.tag_name.trim() : ''\n",
    'release metadata body',
)
write(path, text)


# ---------------------------------------------------------------------------
# adversarial-hardening.js: production screenshot artifacts use atomic writer.
# ---------------------------------------------------------------------------
path = 'lib/adversarial-hardening.js'
text = read(path)
text = replace_once(
    text,
    "import { fileURLToPath, pathToFileURL } from 'node:url'\n",
    "import { fileURLToPath, pathToFileURL } from 'node:url'\n"
    "import { writeArtifactFile } from './artifact-boundary.js'\n",
    'screenshot artifact import',
)
text = replace_once(
    text,
    "  const browserGovernor = deps.browserGovernor ?? defaultHtmlScreenshotGovernor\n",
    "  const browserGovernor = deps.browserGovernor ?? defaultHtmlScreenshotGovernor\n"
    "  const injectedArtifactIo = deps.mkdir !== undefined || deps.writeFile !== undefined || deps.realpathSync !== undefined\n",
    'screenshot injected IO flag',
)
old = '''    const stem = fullPage ? `shot-${width}x${height}-fullpage` : `shot-${width}x${height}`
    const dir = artifactDirectory(exec, config.artifactsDir, realpath)
    await makeDir(dir, { recursive: true })
    const target = path.join(dir, `${core.artifactStemOf(source, stem)}.png`)
    if (!isPathInside(dir, target)) throw new Error('vision_html_screenshot: unsafe artifact target')
    await saveFile(target, png)
'''
new = '''    const stem = fullPage ? `shot-${width}x${height}-fullpage` : `shot-${width}x${height}`
    const fileName = `${core.artifactStemOf(source, stem)}.png`
    let target
    if (!injectedArtifactIo) {
      target = await writeArtifactFile(workspaceOf(exec), config.artifactsDir, fileName, png)
    } else {
      // Unit-test dependency injection keeps the old IO seam, but canonicalize
      // the completed directory before writing so even injected-path tests see
      // the same trust rule as production.
      const dir = artifactDirectory(exec, config.artifactsDir, realpath)
      await makeDir(dir, { recursive: true })
      const workspace = realpathOrResolve(workspaceOf(exec), realpath)
      const dirReal = realpathOrResolve(dir, realpath)
      if (!isPathInside(workspace, dirReal)) {
        throw new Error('vision_html_screenshot: artifact directory escapes the session workspace')
      }
      target = path.join(dirReal, fileName)
      if (!isPathInside(dirReal, target)) throw new Error('vision_html_screenshot: unsafe artifact target')
      await saveFile(target, png)
    }
'''
text = replace_once(text, old, new, 'secure screenshot artifact writer')
write(path, text)


# ---------------------------------------------------------------------------
# vision-resilience.js: bound backend/session indexes and prune stale entries.
# ---------------------------------------------------------------------------
path = 'lib/vision-resilience.js'
text = read(path)
new_breaker = r'''export function createVisionCircuitBreaker({
  now = Date.now,
  authTripTtlMs = 10 * 60 * 1000,
  defaultRateCooldownMs = 60 * 1000,
  maxBackends = 128,
} = {}) {
  const backends = new Map() // LRU key -> { authFingerprint, authAt, cooldownUntil, turnScope }
  const backendLimit = Math.max(1, Math.floor(Number(maxBackends) || 128))

  const touch = (key, hit) => {
    backends.delete(key)
    backends.set(key, hit)
    while (backends.size > backendLimit) {
      const oldest = backends.keys().next().value
      if (oldest === undefined) break
      backends.delete(oldest)
    }
  }
  const entry = (key) => {
    let hit = backends.get(key)
    if (hit === undefined) hit = {}
    touch(key, hit)
    return hit
  }
  const empty = (hit) =>
    hit.authAt === undefined &&
    hit.authFingerprint === undefined &&
    hit.cooldownUntil === undefined &&
    hit.turnScope === undefined

  return {
    inspect(key, fingerprint, scope, at = now()) {
      const hit = backends.get(key)
      if (hit === undefined) return { blocked: false }

      if (hit.cooldownUntil !== undefined) {
        if (hit.cooldownUntil > at) {
          touch(key, hit)
          return { blocked: true, reason: 'rate-limit', until: hit.cooldownUntil }
        }
        delete hit.cooldownUntil
      }
      if (hit.authAt !== undefined) {
        const ttlActive = at - hit.authAt < authTripTtlMs
        const sameFingerprint =
          hit.authFingerprint === fingerprint ||
          hit.authFingerprint === undefined ||
          fingerprint === 'unresolved' ||
          hit.authFingerprint === 'unresolved'
        if (ttlActive && sameFingerprint) {
          touch(key, hit)
          return { blocked: true, reason: 'auth', until: hit.authAt + authTripTtlMs }
        }
        delete hit.authAt
        delete hit.authFingerprint
      }
      if (hit.turnScope !== undefined) {
        if (hit.turnScope === scope) {
          touch(key, hit)
          return { blocked: true, reason: 'turn' }
        }
        // A turn-scoped deterministic failure has no meaning once another
        // scope inspects the backend; prune it instead of retaining a tombstone.
        delete hit.turnScope
      }
      if (empty(hit)) backends.delete(key)
      else touch(key, hit)
      return { blocked: false }
    },

    record(key, fingerprint, classification, scope, at = now()) {
      const { kind, retryAfterMs } = classification
      if (
        kind !== VISION_FAILURE_KINDS.AUTH &&
        kind !== VISION_FAILURE_KINDS.REGION &&
        kind !== VISION_FAILURE_KINDS.TOS &&
        kind !== VISION_FAILURE_KINDS.RATE_LIMIT &&
        kind !== VISION_FAILURE_KINDS.QUOTA &&
        kind !== VISION_FAILURE_KINDS.INVALID_REQUEST &&
        kind !== VISION_FAILURE_KINDS.NO_ADAPTER
      ) {
        return
      }
      const hit = entry(key)
      if (kind === VISION_FAILURE_KINDS.AUTH || kind === VISION_FAILURE_KINDS.REGION || kind === VISION_FAILURE_KINDS.TOS) {
        hit.authAt = at
        hit.authFingerprint = fingerprint
      } else if (kind === VISION_FAILURE_KINDS.RATE_LIMIT) {
        const cooldown = retryAfterMs !== undefined ? retryAfterMs : defaultRateCooldownMs
        hit.cooldownUntil = Math.max(hit.cooldownUntil ?? 0, at + cooldown)
      } else {
        hit.turnScope = scope
      }
      touch(key, hit)
    },

    clear(key) {
      backends.delete(key)
    },

    reset() {
      backends.clear()
    },

    size() {
      return backends.size
    },
  }
}
'''
text = regex_once(
    text,
    r"export function createVisionCircuitBreaker\(\{.*?^\}\n(?=\n/\*\*\n \* Turn-level failure memory)",
    new_breaker,
    'bounded circuit breaker',
)
new_turn = r'''export function createVisionTurnMemory({
  maxScopes = 64,
  maxSessions = maxScopes,
  maxAttemptsPerScope = 64,
} = {}) {
  const scopes = new Map() // scope -> { failedKinds:Set, attempted: [], allFailed:false }
  const lastScopeBySession = new Map() // bounded LRU sessionId -> scope
  const scopeLimit = Math.max(1, Math.floor(Number(maxScopes) || 64))
  const sessionLimit = Math.max(1, Math.floor(Number(maxSessions) || scopeLimit))
  const attemptLimit = Math.max(1, Math.floor(Number(maxAttemptsPerScope) || 64))

  const dropScope = (scope) => {
    scopes.delete(scope)
    for (const [sessionId, tracked] of lastScopeBySession) {
      if (tracked === scope) lastScopeBySession.delete(sessionId)
    }
  }
  const pruneScopes = () => {
    while (scopes.size > scopeLimit) {
      const oldest = scopes.keys().next().value
      if (oldest === undefined) break
      dropScope(oldest)
    }
  }
  const touchSession = (sessionId, scope) => {
    lastScopeBySession.delete(sessionId)
    lastScopeBySession.set(sessionId, scope)
    while (lastScopeBySession.size > sessionLimit) {
      const oldest = lastScopeBySession.keys().next().value
      if (oldest === undefined) break
      const tracked = lastScopeBySession.get(oldest)
      lastScopeBySession.delete(oldest)
      if (tracked !== undefined) scopes.delete(tracked)
    }
  }
  const entry = (scope) => {
    let hit = scopes.get(scope)
    if (hit === undefined) {
      hit = { failedKinds: new Set(), attempted: [], allFailed: false }
      scopes.set(scope, hit)
      pruneScopes()
    } else {
      scopes.delete(scope)
      scopes.set(scope, hit)
    }
    return hit
  }

  return {
    bindSession(sessionId, scope) {
      const previous = lastScopeBySession.get(sessionId)
      if (previous !== undefined && previous !== scope) dropScope(previous)
      touchSession(sessionId, scope)
    },

    allFailed(scope) {
      const hit = scopes.get(scope)
      return hit !== undefined && hit.allFailed
    },

    record(scope, backendId, kind) {
      const hit = entry(scope)
      hit.failedKinds.add(kind)
      if (hit.attempted.length >= attemptLimit) hit.attempted.shift()
      hit.attempted.push({ backend: backendId, kind })
    },

    markAllFailed(scope) {
      entry(scope).allFailed = true
    },

    failedKinds(scope) {
      const hit = scopes.get(scope)
      return hit === undefined ? [] : [...hit.failedKinds]
    },

    attempted(scope) {
      const hit = scopes.get(scope)
      return hit === undefined ? [] : [...hit.attempted]
    },

    stats() {
      return { scopes: scopes.size, sessions: lastScopeBySession.size }
    },

    reset() {
      scopes.clear()
      lastScopeBySession.clear()
    },
  }
}
'''
text = regex_once(
    text,
    r"export function createVisionTurnMemory\(\{ maxScopes = 64 \} = \{\}\) \{.*?^\}\n(?=\n/\*\*\n \* Build the structured)",
    new_turn,
    'bounded turn memory',
)
write(path, text)


# ---------------------------------------------------------------------------
# Regression tests. Keep additions inside already-enumerated test files.
# ---------------------------------------------------------------------------
path = 'tests/core.test.js'
text = read(path)
marker = "\ntest('batch3: JSON extraction is one-pass and cache retention is byte-bounded', () => {"
if marker not in text:
    text += r'''

test('batch3: JSON extraction is one-pass and cache retention is byte-bounded', () => {
  const originalParse = JSON.parse
  let parses = 0
  JSON.parse = (...args) => {
    parses += 1
    return originalParse(...args)
  }
  try {
    const parsed = extractJson('{"a":[1,{"text":"} ]"}]}'+ 'x'.repeat(200_000))
    assert.deepEqual(parsed, { a: [1, { text: '} ]' }] })
    assert.equal(parses, 1, 'one balanced candidate should be parsed once, never one suffix at a time')
  } finally {
    JSON.parse = originalParse
  }

  const cache = createCache(100, 0, { maxBytes: 80, maxEntryBytes: 64 })
  assert.equal(cache.set('a', 'x'.repeat(40)), true)
  assert.equal(cache.set('b', 'y'.repeat(40)), true)
  assert.ok(cache.bytes <= 80)
  assert.equal(cache.get('a'), undefined, 'byte pressure evicts LRU entries before count pressure')
  assert.equal(cache.set('too-big', 'z'.repeat(1000)), false)
  assert.ok(cache.bytes <= 80)

  const key = cacheKeyFor({
    pairs: [{ provider: 'p', model: 'm' }],
    httpProviders: [],
    contentIds: ['sha256:x'],
    wantJson: false,
    question: 'secret-question-'.repeat(100_000),
  })
  assert.match(key, /^v2:[a-f0-9]{64}$/)
  assert.equal(key.includes('secret-question'), false)
})

test('batch3: direct OpenAI success bodies are rejected before oversized JSON allocation', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('{"choices":[]}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) },
  })
  try {
    await assert.rejects(
      callOpenAICompatible(
        { name: 'bounded', baseURL: 'https://example.com/v1', model: 'm' },
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ),
      (error) => error && error.code === 'HTTP_RESPONSE_TOO_LARGE',
    )
  } finally {
    globalThis.fetch = original
  }
})
'''
write(path, text)

path = 'tests/vision-resilience.test.js'
text = read(path)
if "batch3: circuit breaker and turn/session indexes remain bounded" not in text:
    text += r'''

test('batch3: circuit breaker and turn/session indexes remain bounded', () => {
  const breaker = createVisionCircuitBreaker({ maxBackends: 16 })
  for (let i = 0; i < 10_000; i++) {
    breaker.record(`provider-${i}/model`, 'fp', { kind: 'AUTH' }, `s:${i}`)
  }
  assert.ok(breaker.size() <= 16)

  let now = 0
  const expiring = createVisionCircuitBreaker({ now: () => now, authTripTtlMs: 10 })
  expiring.record('old/model', 'fp', { kind: 'AUTH' }, 's:1')
  assert.equal(expiring.size(), 1)
  now = 11
  assert.equal(expiring.inspect('old/model', 'fp', 's:2').blocked, false)
  assert.equal(expiring.size(), 0, 'expired empty circuit entries should be removed, not tombstoned')

  const memory = createVisionTurnMemory({ maxScopes: 8, maxSessions: 8, maxAttemptsPerScope: 4 })
  for (let i = 0; i < 10_000; i++) {
    const scope = `session-${i}:1`
    memory.bindSession(`session-${i}`, scope)
    for (let attempt = 0; attempt < 10; attempt++) memory.record(scope, `p/${attempt}`, 'AUTH')
  }
  assert.deepEqual(memory.stats(), { scopes: 8, sessions: 8 })
  assert.equal(memory.attempted('session-9999:1').length, 4)
})
'''
write(path, text)

path = 'tests/http-compat.test.js'
text = read(path)
if "batch3: bounded HTTP body reader counts streamed bytes" not in text:
    text += r'''

test('batch3: bounded HTTP body reader counts streamed bytes and declared length', async () => {
  const {
    readResponseJsonBounded,
  } = await import('../lib/http-body-limit.js')

  const declared = new Response('{"ok":true}', {
    headers: { 'content-length': '999999' },
  })
  await assert.rejects(
    readResponseJsonBounded(declared, 1024, { label: 'declared test' }),
    (error) => error && error.code === 'HTTP_RESPONSE_TOO_LARGE',
  )

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(800))
      controller.enqueue(new Uint8Array(800))
      controller.close()
    },
  })
  const streamed = new Response(stream)
  await assert.rejects(
    readResponseJsonBounded(streamed, 1024, { label: 'stream test' }),
    (error) => error && error.code === 'HTTP_RESPONSE_TOO_LARGE',
  )
})
'''
write(path, text)

path = 'tests/catalog-corrections.test.js'
text = read(path)
if "batch3: Anthropic success admission rejects oversized bodies" not in text:
    text += r'''

test('batch3: Anthropic success admission rejects oversized bodies', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response('{"content":[]}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) },
  })
  try {
    await assert.rejects(
      callAnthropicCompatible(
        { name: 'local', baseURL: 'http://127.0.0.1:1234', model: 'm', apiKeyEnv: '' },
        [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        { allowKeyless: true },
      ),
      (error) => error && error.code === 'HTTP_RESPONSE_TOO_LARGE',
    )
  } finally {
    globalThis.fetch = original
  }
})
'''
write(path, text)

path = 'tests/update-check.test.js'
text = read(path)
if "batch3: update metadata cannot exceed the bounded admission size" not in text:
    text += r'''

test('batch3: update metadata cannot exceed the bounded admission size', async () => {
  const fetchImpl = async () => new Response('{"version":"9.9.9"}', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) },
  })
  await assert.rejects(
    checkPackageUpdate({
      fetchImpl,
      currentVersion: '1.0.0',
      registry: 'https://registry.example',
      fallbackRegistry: 'https://registry.example',
      releaseApi: 'https://release.example/latest',
    }),
    /invalid version|invalid tag|response limit|failed/,
  )
})
'''
write(path, text)

path = 'tests/adversarial-hardening.test.js'
text = read(path)
if "batch3: artifact writer rejects symlink escape" not in text:
    text += r'''

test('batch3: artifact writer rejects symlink escape and never follows final symlinks', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation privileges vary on Windows runners')
    return
  }
  const { mkdir, symlink } = await import('node:fs/promises')
  const { writeArtifactFile } = await import('../lib/artifact-boundary.js')
  const workspace = await mkdtemp(path.join(tmpdir(), 'vision-artifact-workspace-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'vision-artifact-outside-'))
  try {
    const artifactLink = path.join(workspace, '.dsh-vision-router', 'artifacts')
    await mkdir(path.dirname(artifactLink), { recursive: true })
    await symlink(outside, artifactLink, 'dir')
    await assert.rejects(
      writeArtifactFile(workspace, '.dsh-vision-router/artifacts', 'escape.png', Buffer.from('bad')),
      /escapes the session workspace/,
    )
    await assert.rejects(readFile(path.join(outside, 'escape.png')), /ENOENT/)

    await rm(artifactLink, { force: true })
    await mkdir(artifactLink, { recursive: true })
    const secret = path.join(outside, 'secret.txt')
    await writeFile(secret, 'secret')
    const target = path.join(artifactLink, 'safe.png')
    await symlink(secret, target)
    const written = await writeArtifactFile(
      workspace,
      '.dsh-vision-router/artifacts',
      'safe.png',
      Buffer.from('artifact'),
    )
    assert.equal((await readFile(secret)).toString(), 'secret', 'final symlink target must never be overwritten')
    assert.equal((await readFile(written)).toString(), 'artifact')
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('batch3: core and secure screenshot outputs both use the canonical artifact boundary', async () => {
  const coreSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const hardeningSource = await readFile(new URL('../lib/adversarial-hardening.js', import.meta.url), 'utf8')
  assert.match(coreSource, /writeArtifactFile\(workspaceOf\(exec\), artifactsRel, relPath, data\)/)
  assert.doesNotMatch(coreSource, /writeFile\(path\.join\(dir, chunkRel\), chunk\)/)
  assert.match(hardeningSource, /writeArtifactFile\(workspaceOf\(exec\), config\.artifactsDir, fileName, png\)/)
})
'''
write(path, text)

print('batch3 patch applied successfully')
