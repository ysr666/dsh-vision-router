#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROUND2_SUITE_REVISION } from './corpus.mjs'

const DEFAULT_ARTIFACTS = '.artifacts/vision-quality-round2'
const DEFAULT_PROVIDER = 'deepseek-vision'
const DEFAULT_MODEL = 'deepseek-flash'
const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000
const DEFAULT_POLL_MS = 250

function usage() {
  return `Vision Round 2 Host API runner\n\n` +
    `Required:\n` +
    `  --runtime-template <dir>   isolated template root containing .dsh/\n` +
    `  --dsh-spec <npm-spec>      e.g. @deepseek-ai/dsh@0.1.5-rc.1\n\n` +
    `Options:\n` +
    `  --artifacts <dir>          rendered fixtures + manifest (default: ${DEFAULT_ARTIFACTS})\n` +
    `  --out <file>               JSONL result path\n` +
    `  --history-dir <dir>        per-case history + Host logs\n` +
    `  --provider <id>            session model provider (default: ${DEFAULT_PROVIDER})\n` +
    `  --model <id>               session model id (default: ${DEFAULT_MODEL})\n` +
    `  --reasoning-effort <value> selection reasoning effort (default: high; use "none" to omit)\n` +
    `  --ids <a,b,...>            run only these case ids\n` +
    `  --category <name>          run one category\n` +
    `  --timeout-ms <n>           one case wall-clock bound (default: ${DEFAULT_TIMEOUT_MS})\n` +
    `  --between-cases-ms <n>     delay between cases (default: 0)\n` +
    `  --expect-vision-tools <n>  require exact DVR vision-tool count\n` +
    `  --resume                   append missing ids to an existing result file\n` +
    `  --overwrite                replace an existing result file\n` +
    `  --keep-runtimes            retain isolated runtime/workspace dirs\n` +
    `  --help                     show this help\n`
}

export function parseArgs(argv) {
  const valueFlags = new Set([
    '--runtime-template', '--dsh-spec', '--artifacts', '--out', '--history-dir',
    '--provider', '--model', '--reasoning-effort', '--ids', '--category',
    '--timeout-ms', '--startup-timeout-ms', '--poll-ms', '--between-cases-ms',
    '--expect-vision-tools',
  ])
  const booleanFlags = new Set(['--resume', '--overwrite', '--keep-runtimes', '--help'])
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (booleanFlags.has(arg)) { options[arg.slice(2)] = true; continue }
    if (!valueFlags.has(arg)) throw new Error(`unknown option: ${arg}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    options[arg.slice(2)] = value
    index += 1
  }
  return options
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`)
  return number
}

function nonNegativeInteger(value, fallback, name) {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`)
  return number
}

function sanitizeId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_')
}

export function redactHostLog(text) {
  return String(text).replace(/([?&](?:token|key)=)[^&\s]+/gi, '$1<redacted>')
}

function eventsOf(page) {
  return (page?.records ?? []).flatMap(record => record?.type === 'event' ? [record.event] : [])
}

function assistantText(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

class RemoteRpcError extends Error {
  constructor(endpoint, error) {
    super(`${endpoint} RPC failed: ${error?.code ?? 'unknown'}: ${error?.message ?? JSON.stringify(error)}`)
    this.code = error?.code
    this.details = error?.details
  }
}

async function pathExists(target) {
  try { await stat(target); return true } catch { return false }
}

function isPathInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function scrubVisionRouterPackages(runtimeRoot) {
  const canonicalRuntimeRoot = await realpath(runtimeRoot)
  const profilesRoot = path.join(runtimeRoot, '.dsh', 'profiles')
  const profiles = await readdir(profilesRoot, { withFileTypes: true })
  let scrubbed = 0
  for (const profile of profiles) {
    if (!profile.isDirectory()) continue
    const packageLink = path.join(profilesRoot, profile.name, 'node_modules', 'dsh-vision-router')
    if (!await pathExists(packageLink)) continue
    const packageRoot = await realpath(packageLink)
    if (!isPathInside(canonicalRuntimeRoot, packageRoot)) {
      throw new Error(`benchmark runtime contains an external dsh-vision-router symlink: ${packageLink} -> ${packageRoot}`)
    }
    const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error(`dsh-vision-router package has no files allow-list; cannot remove benchmark answer assets safely: ${packageRoot}`)
    }
    const allowed = new Set(['package.json'])
    for (const entry of manifest.files) {
      const clean = String(entry).replace(/^\.\/+/, '')
      const top = clean.split(/[\\/]/u)[0]
      if (top === '' || /[*?\[\]{}]/u.test(top)) {
        throw new Error(`unsupported top-level package files pattern for benchmark scrub: ${entry}`)
      }
      allowed.add(top)
    }
    for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
      if (!allowed.has(entry.name)) await rm(path.join(packageRoot, entry.name), { recursive: true, force: true })
    }
    scrubbed += 1
  }
  if (scrubbed === 0) throw new Error('runtime template contains no installed dsh-vision-router package to benchmark')
}

export async function cloneRuntimeTemplate(templateRoot, runtimeRoot) {
  const sourceDsh = path.join(templateRoot, '.dsh')
  if (!await pathExists(sourceDsh)) throw new Error(`runtime template has no .dsh directory: ${templateRoot}`)
  const targetDsh = path.join(runtimeRoot, '.dsh')
  const excludedTopLevel = new Set(['sessions', 'attachments', 'logs', 'storages', 'llm-deepseek'])
  await cp(sourceDsh, targetDsh, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceDsh, source)
      if (relative === '') return true
      const first = relative.split(path.sep)[0]
      return !excludedTopLevel.has(first)
    },
  })
  await mkdir(path.join(runtimeRoot, '.agents'), { recursive: true })
  await scrubVisionRouterPackages(runtimeRoot)
}

function attachRedactedHostLog(child, hostLogPath) {
  const output = createWriteStream(hostLogPath, { flags: 'a' })
  let pending = ''
  const consume = chunk => {
    pending += chunk.toString()
    let newline
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline + 1)
      pending = pending.slice(newline + 1)
      output.write(redactHostLog(line))
    }
  }
  const flush = () => {
    if (pending !== '') output.write(redactHostLog(pending))
    pending = ''
    output.end()
  }
  child.stdout?.on('data', consume)
  child.stderr?.on('data', consume)
  child.once('close', flush)
}

async function waitForReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let raw = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`DSH Host did not become ready within ${timeoutMs}ms`)), timeoutMs)
    const inspect = chunk => {
      raw = `${raw}${chunk.toString()}`.slice(-16_384)
      const match = /dsh web: (http:\/\/[^\s]+)/.exec(raw)
      if (match?.[1]) finish(undefined, match[1])
    }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.off('data', inspect)
      child.stderr?.off('data', inspect)
      if (error) reject(error)
      else resolve(value)
    }
    child.stdout?.on('data', inspect)
    child.stderr?.on('data', inspect)
    child.once('exit', code => finish(new Error(`DSH Host exited before readiness with code ${code}`)))
    child.once('error', error => finish(error))
  })
}

async function authenticate(launchUrl) {
  const response = await fetch(launchUrl, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  if (response.status !== 303 || !cookie) throw new Error(`browser auth exchange returned HTTP ${response.status}`)
  return { origin: new URL(launchUrl).origin, cookie: cookie.split(';', 1)[0] }
}

async function remoteRpc(auth, endpoint, args) {
  const response = await fetch(`${auth.origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: auth.cookie },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `round2-${endpoint}-${randomUUID()}`,
      method: endpoint,
      payload: { args },
    }),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}: ${text.slice(0, 1000)}`)
  const body = JSON.parse(text)
  if (!body?.result?.ok) throw new RemoteRpcError(endpoint, body?.result?.error)
  return body.result.value
}

async function pageAt(auth, sessionId, throughSeq) {
  return remoteRpc(auth, 'session/page', {
    request: {
      address: { kind: 'session', sessionId },
      throughSeq,
      maxMessages: 1000,
    },
  })
}

async function observeHistory(auth, sessionId, deadlineMs, pollMs) {
  let latestPage
  let latestSummary
  while (Date.now() < deadlineMs) {
    const listed = await remoteRpc(auth, 'session/list', { _request: {} })
    latestSummary = listed?.items?.find?.(item => item?.sessionId === sessionId)
    const throughSeq = latestSummary?.projections?.asOfSeq
    if (Number.isSafeInteger(throughSeq) && throughSeq >= 0) {
      latestPage = await pageAt(auth, sessionId, throughSeq)
      const events = eventsOf(latestPage)
      if (latestSummary?.running === false && events.some(event => event.type === 'turn/end')) {
        return { page: latestPage, completed: true, summary: latestSummary }
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs))
  }
  // A timeout is a benchmark result, not an infrastructure exception. Capture
  // the freshest projection/page available so tool-loop failures remain measurable.
  if (latestPage !== undefined) return { page: latestPage, completed: false, summary: latestSummary }
  throw new Error(`session ${sessionId} exposed no readable projection before the case deadline`)
}

export function requestSurface(events) {
  const headers = events.filter(event => event?.type === 'request/header').map(event => event?.data?.header).filter(Boolean)
  const matching = headers.filter(header => header?.config)
  const visionCounts = matching.map(header => {
    const tools = Array.isArray(header?.tools) ? header.tools : []
    return tools.filter(tool => String(tool?.name ?? '').startsWith('vision_')).length
  })
  return {
    headers: matching.length,
    provider: matching.at(-1)?.config?.provider,
    model: matching.at(-1)?.config?.model,
    visionToolCount: visionCounts.length > 0 ? Math.max(...visionCounts) : 0,
  }
}

export function reasoningEffortOption(value) {
  if (value === 'none') return undefined
  return value || 'high'
}

export function modelSelectionRequest(sessionId, options) {
  return {
    sessionId,
    provider: options.provider,
    model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
  }
}

export function assertSurface(surface, options, caseId) {
  if (surface.headers === 0) throw new Error(`${caseId}: no request/header reached the model`)
  if (surface.provider !== options.provider || surface.model !== options.model) {
    throw new Error(`${caseId}: model mismatch; expected ${options.provider}/${options.model}, got ${surface.provider}/${surface.model}`)
  }
  if (surface.visionToolCount < 1) throw new Error(`${caseId}: no Vision Router tools were published; Vision route is not active`)
  if (options.expectVisionTools !== undefined && surface.visionToolCount !== options.expectVisionTools) {
    throw new Error(`${caseId}: expected ${options.expectVisionTools} Vision Router tools, got ${surface.visionToolCount}`)
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
}

async function runCase(item, options) {
  const safeId = sanitizeId(item.id)
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), `dvr-r2-runtime-${safeId}-`))
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), `dvr-r2-workspace-${safeId}-`))
  const historyPath = path.join(options.historyDir, `history-${safeId}.json`)
  const hostLogPath = path.join(options.historyDir, `host-${safeId}.log`)
  let child
  const startedAt = Date.now()
  try {
    await cloneRuntimeTemplate(options.runtimeTemplate, runtimeRoot)
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    child = spawn(npx, ['-y', options.dshSpec, 'web', '--no-open', '--port', '0'], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        DSH_HOME: path.join(runtimeRoot, '.dsh'),
        DSH_AGENTS_HOME: path.join(runtimeRoot, '.agents'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    attachRedactedHostLog(child, hostLogPath)
    const launchUrl = await waitForReady(child, options.startupTimeoutMs)
    const auth = await authenticate(launchUrl)
    const created = await remoteRpc(auth, 'session/create', { request: { cwd: workspaceRoot } })
    const sessionId = created?.sessionId
    if (!sessionId) throw new Error(`${item.id}: session/create returned no sessionId`)
    await remoteRpc(auth, 'session/selectModel', {
      request: modelSelectionRequest(sessionId, options),
    })
    const content = []
    for (const imageName of item.images) {
      if (path.basename(imageName) !== imageName) throw new Error(`${item.id}: unsafe fixture path ${imageName}`)
      const fixturePath = path.join(options.artifacts, imageName)
      content.push({
        type: 'image',
        mediaType: 'image/png',
        data: (await readFile(fixturePath)).toString('base64'),
        name: imageName,
      })
    }
    content.push({ type: 'text', text: item.question })
    await remoteRpc(auth, 'session/prompt', {
      request: {
        requestId: `round2-${randomUUID()}`,
        sessionId,
        mode: 'queue',
        content,
        clientTimeZone: 'UTC',
      },
    })
    const observed = await observeHistory(auth, sessionId, Date.now() + options.timeoutMs, options.pollMs)
    const events = eventsOf(observed.page)
    const surface = requestSurface(events)
    assertSurface(surface, options, item.id)
    const answers = events
      .filter(event => event?.type === 'assistant/message')
      .map(assistantText)
      .filter(text => text !== '')
    const result = {
      id: item.id,
      answer: answers.at(-1) ?? '',
      toolCalls: events.filter(event => event?.type === 'tool/call').length,
      completed: observed.completed,
      elapsedMs: Date.now() - startedAt,
      sessionId,
      provider: surface.provider,
      model: surface.model,
      visionToolCount: surface.visionToolCount,
    }
    await writeFile(historyPath, `${JSON.stringify(observed.page, null, 2)}\n`)
    return result
  } finally {
    await stopChild(child)
    if (!options.keepRuntimes) {
      await Promise.all([
        rm(runtimeRoot, { recursive: true, force: true }),
        rm(workspaceRoot, { recursive: true, force: true }),
      ])
    } else {
      console.error(`kept runtime=${runtimeRoot} workspace=${workspaceRoot}`)
    }
  }
}

async function loadExistingIds(outPath) {
  if (!await pathExists(outPath)) return new Set()
  const text = await readFile(outPath, 'utf8')
  const ids = new Set()
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue
    let row
    try { row = JSON.parse(line) } catch { throw new Error(`${outPath}:${index + 1}: invalid JSONL`) }
    const id = String(row?.id ?? '')
    if (id === '') throw new Error(`${outPath}:${index + 1}: missing id`)
    if (ids.has(id)) throw new Error(`${outPath}: duplicate result id ${id}`)
    ids.add(id)
  }
  return ids
}

export async function main() {
  const raw = parseArgs(process.argv.slice(2))
  if (raw.help) { process.stdout.write(usage()); return }
  if (!raw['runtime-template']) throw new Error('--runtime-template is required')
  if (!raw['dsh-spec']) throw new Error('--dsh-spec is required')
  if (raw.resume && raw.overwrite) throw new Error('--resume and --overwrite are mutually exclusive')

  const artifacts = path.resolve(raw.artifacts || DEFAULT_ARTIFACTS)
  const outPath = path.resolve(raw.out || path.join(artifacts, 'results-host-api.jsonl'))
  const historyDir = path.resolve(raw['history-dir'] || path.join(artifacts, 'history-host-api'))
  const options = {
    runtimeTemplate: path.resolve(raw['runtime-template']),
    dshSpec: raw['dsh-spec'],
    artifacts,
    outPath,
    historyDir,
    provider: raw.provider || DEFAULT_PROVIDER,
    model: raw.model || DEFAULT_MODEL,
    reasoningEffort: reasoningEffortOption(raw['reasoning-effort']),
    timeoutMs: positiveInteger(raw['timeout-ms'], DEFAULT_TIMEOUT_MS, '--timeout-ms'),
    startupTimeoutMs: positiveInteger(raw['startup-timeout-ms'], DEFAULT_STARTUP_TIMEOUT_MS, '--startup-timeout-ms'),
    pollMs: positiveInteger(raw['poll-ms'], DEFAULT_POLL_MS, '--poll-ms'),
    betweenCasesMs: nonNegativeInteger(raw['between-cases-ms'], 0, '--between-cases-ms'),
    expectVisionTools: raw['expect-vision-tools'] === undefined
      ? undefined
      : positiveInteger(raw['expect-vision-tools'], undefined, '--expect-vision-tools'),
    keepRuntimes: raw['keep-runtimes'] === true,
  }

  const manifestPath = path.join(artifacts, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest?.suiteRevision !== ROUND2_SUITE_REVISION) {
    throw new Error(`manifest suite revision ${manifest?.suiteRevision} != runner revision ${ROUND2_SUITE_REVISION}; rerun quality:round2:render`)
  }
  let selected = Array.isArray(manifest.cases) ? manifest.cases : []
  const ids = new Set(String(raw.ids ?? '').split(',').map(value => value.trim()).filter(Boolean))
  if (ids.size > 0) {
    selected = selected.filter(item => ids.has(item.id))
    const missing = [...ids].filter(id => !selected.some(item => item.id === id))
    if (missing.length > 0) throw new Error(`unknown --ids: ${missing.join(', ')}`)
  }
  if (raw.category) selected = selected.filter(item => item.category === raw.category)
  if (selected.length === 0) throw new Error('no Round 2 cases selected')

  await mkdir(path.dirname(outPath), { recursive: true })
  await mkdir(historyDir, { recursive: true })
  if (raw.overwrite) await writeFile(outPath, '')
  else if (!raw.resume && await pathExists(outPath)) throw new Error(`${outPath} already exists; use --resume or --overwrite`)
  const completedIds = raw.resume ? await loadExistingIds(outPath) : new Set()

  let ran = 0
  for (const item of selected) {
    if (completedIds.has(item.id)) { console.log(`SKIP ${item.id} (already in results)`); continue }
    if (ran > 0 && options.betweenCasesMs > 0) await new Promise(resolve => setTimeout(resolve, options.betweenCasesMs))
    console.log(`RUN ${item.id}`)
    const result = await runCase(item, options)
    await writeFile(outPath, `${JSON.stringify(result)}\n`, { flag: 'a' })
    console.log(`RESULT ${item.id} completed=${result.completed} calls=${result.toolCalls} elapsedMs=${result.elapsedMs} answer=${JSON.stringify(result.answer)}`)
    ran += 1
  }
  console.log(`wrote ${ran} new result(s) to ${outPath}`)
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch(error => {
    console.error(error?.stack ?? String(error))
    process.exitCode = 1
  })
}
