import { existsSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeArtifactFile } from './artifact-boundary.js'
import { assertScreenshotSourceInWorkspace } from './screenshot-source-boundary.js'

const DEFAULT_ARTIFACTS_DIR = '.dsh-vision-router/artifacts'
const MAX_VIEWPORT_WIDTH = 4096
const MAX_VIEWPORT_HEIGHT = 4096
const MAX_SCREENSHOT_PIXELS = 50_000_000
export const MAX_FULL_PAGE_WAKE_STEPS = 512
export const MAX_FULL_PAGE_WAKE_MS = 15_000
export const MAX_HTML_SCREENSHOT_CONCURRENT = 2

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export function normalizeArtifactsDir(value) {
  if (!isNonEmptyString(value)) return DEFAULT_ARTIFACTS_DIR
  const raw = value.trim()
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) return DEFAULT_ARTIFACTS_DIR
  const parts = raw.split(/[\\/]+/)
  if (parts.some((part) => part === '..')) return DEFAULT_ARTIFACTS_DIR
  const normalized = path.normalize(raw)
  if (normalized === '' || normalized === '.' || normalized === path.sep) return DEFAULT_ARTIFACTS_DIR
  return normalized
}

function hardenConfig(config = {}) {
  const value = config && typeof config === 'object' ? config : {}
  return { ...value, artifactsDir: normalizeArtifactsDir(value.artifactsDir) }
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function realpathOrResolve(value, realpath = realpathSync) {
  try {
    return realpath(value)
  } catch {
    return path.resolve(value)
  }
}

function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return isNonEmptyString(cwd) ? cwd : process.cwd()
}

function artifactDirectory(exec, configured, realpath = realpathSync) {
  const workspace = realpathOrResolve(workspaceOf(exec), realpath)
  const relative = normalizeArtifactsDir(configured)
  const target = path.resolve(workspace, relative)
  if (!isPathInside(workspace, target)) {
    throw new Error('vision-router: artifactsDir must stay inside the session workspace')
  }
  return target
}

export function sameOriginRequest(req) {
  const origin = req?.headers?.origin
  const host = req?.headers?.host
  const fetchSite = req?.headers?.['sec-fetch-site']
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  if (!origin) return true
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function safeViewportDimension(value, fallback, max, label) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`vision_html_screenshot: ${label} must be an integer between 1 and ${max}`)
  }
  return value
}

export function htmlRequestAllowed(urlValue, allowedRoot) {
  let url
  try {
    url = new URL(urlValue)
  } catch {
    return false
  }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return true
  if (url.protocol !== 'file:') return false
  let filePath
  let root
  try {
    filePath = realpathSync(fileURLToPath(url))
    // The allowed root can sit under a symlinked path (macOS /var ->
    // /private/var, /tmp -> /private/tmp). Resolve it the same way the file
    // path is resolved, otherwise genuinely local files fail the containment
    // check. Fail closed when the root cannot be resolved at all.
    root = realpathSync(allowedRoot)
  } catch {
    return false
  }
  return isPathInside(root, filePath)
}

function wrapRequestInterception(page, allowedRoot) {
  return page.setRequestInterception(true).then(() => {
    page.on('request', (request) => {
      try {
        if (htmlRequestAllowed(request.url(), allowedRoot)) request.continue()
        else request.abort('blockedbyclient')
      } catch {
        try { request.abort('blockedbyclient') } catch { /* best effort */ }
      }
    })
  })
}

/**
 * Full scrollable page height (CSS px). The viewport height is part of the max:
 * an empty page has zero scroll height and must not be misreported as zero.
 */
export async function fullPageHeightOf(page) {
  return await page.evaluate(() => Math.max(
    document.documentElement?.scrollHeight ?? 0,
    document.body?.scrollHeight ?? 0,
    window.innerHeight,
  ))
}

function assertSafeFullPageHeight(pageHeight, width) {
  if (!Number.isFinite(pageHeight) || pageHeight <= 0 || width * pageHeight > MAX_SCREENSHOT_PIXELS) {
    throw new Error(
      `vision_html_screenshot: full-page capture exceeds the ${MAX_SCREENSHOT_PIXELS} pixel safety limit`,
    )
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wake lazy/scroll-triggered content without turning the wake itself into a
 * denial-of-service primitive.
 *
 * Safety is checked BEFORE the first scroll and after every reveal step. A
 * malicious page with a gigantic static scrollHeight is therefore rejected in
 * O(1) work instead of being walked tens of thousands of times before the old
 * pixel check ran. Dynamically growing pages are bounded by both the pixel
 * ceiling and independent step/wall-clock ceilings.
 */
export async function wakePageForFullCaptureBounded(
  page,
  viewportHeight,
  width,
  options = {},
) {
  const step = Number.isInteger(viewportHeight) && viewportHeight > 0 ? viewportHeight : 720
  const maxSteps =
    Number.isInteger(options.maxSteps) && options.maxSteps > 0
      ? options.maxSteps
      : MAX_FULL_PAGE_WAKE_STEPS
  const maxWakeMs =
    Number.isFinite(options.maxWakeMs) && options.maxWakeMs > 0
      ? Number(options.maxWakeMs)
      : MAX_FULL_PAGE_WAKE_MS
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep
  const now = typeof options.now === 'function' ? options.now : Date.now

  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = 'auto'
  })

  let total = await fullPageHeightOf(page)
  // Critical ordering invariant: reject an already-impossible page before any
  // scroll/wait work is performed.
  assertSafeFullPageHeight(total, width)

  const startedAt = Number(now())
  let steps = 0
  for (let y = 0; y < total; y += step) {
    if (steps >= maxSteps || Number(now()) - startedAt >= maxWakeMs) {
      throw new Error(
        `vision_html_screenshot: full-page wake exceeds the ${maxSteps}-step / ${maxWakeMs}ms safety limit`,
      )
    }
    await page.evaluate((yy) => window.scrollTo(0, yy), y)
    steps += 1
    await sleep(60)

    const observed = await fullPageHeightOf(page)
    assertSafeFullPageHeight(observed, width)
    // Scroll-triggered pages may grow while they are being woken. Continue to
    // the newly revealed bottom, but never beyond the resource bounds above.
    total = Math.max(total, observed)
  }

  await page.evaluate(() => window.scrollTo(0, 0))
  const remainingWakeMs = maxWakeMs - (Number(now()) - startedAt)
  if (remainingWakeMs <= 0) {
    throw new Error(
      `vision_html_screenshot: full-page wake exceeds the ${maxSteps}-step / ${maxWakeMs}ms safety limit`,
    )
  }
  await sleep(Math.min(800, remainingWakeMs))
  if (Number(now()) - startedAt > maxWakeMs) {
    throw new Error(
      `vision_html_screenshot: full-page wake exceeds the ${maxSteps}-step / ${maxWakeMs}ms safety limit`,
    )
  }

  const finalHeight = await fullPageHeightOf(page)
  assertSafeFullPageHeight(finalHeight, width)
  return finalHeight
}

function screenshotAbortError() {
  const error = new Error('vision_html_screenshot: browser work aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

/** Process-level FIFO cap for heavyweight headless-browser instances. */
export class HtmlScreenshotGovernor {
  constructor({ maxConcurrent = MAX_HTML_SCREENSHOT_CONCURRENT } = {}) {
    this.maxConcurrent = Math.max(1, Math.floor(Number(maxConcurrent) || MAX_HTML_SCREENSHOT_CONCURRENT))
    this.active = 0
    this.queue = []
  }

  _grant(item) {
    if (item.settled) return
    item.settled = true
    if (item.signal && item.abortHandler) item.signal.removeEventListener('abort', item.abortHandler)
    this.active += 1
    let released = false
    item.resolve(() => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      this._drain()
    })
  }

  _drain() {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()
      if (!item || item.settled) continue
      this._grant(item)
    }
  }

  acquire({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(screenshotAbortError())
    return new Promise((resolve, reject) => {
      const item = {
        signal,
        resolve,
        reject,
        settled: false,
        abortHandler: undefined,
      }
      item.abortHandler = () => {
        if (item.settled) return
        item.settled = true
        const index = this.queue.indexOf(item)
        if (index >= 0) this.queue.splice(index, 1)
        reject(screenshotAbortError())
        this._drain()
      }
      if (signal) signal.addEventListener('abort', item.abortHandler, { once: true })
      if (this.active < this.maxConcurrent && this.queue.length === 0) this._grant(item)
      else this.queue.push(item)
    })
  }

  stats() {
    return {
      maxConcurrent: this.maxConcurrent,
      active: this.active,
      queued: this.queue.filter((item) => !item.settled).length,
    }
  }
}

export const defaultHtmlScreenshotGovernor = new HtmlScreenshotGovernor()

export function createSecureHtmlScreenshotExecute(ctx, core, config, deps = {}) {
  const importPuppeteer = deps.importPuppeteer ?? (() => import('puppeteer-core'))
  const fileExists = deps.existsSync ?? existsSync
  const makeDir = deps.mkdir ?? mkdir
  const saveFile = deps.writeFile ?? writeFile
  const realpath = deps.realpathSync ?? realpathSync
  const browserGovernor = deps.browserGovernor ?? defaultHtmlScreenshotGovernor
  const injectedArtifactIo = deps.mkdir !== undefined || deps.writeFile !== undefined || deps.realpathSync !== undefined

  return async (args, exec) => {
    const source = String(args?.source ?? '')
    const signal = exec?.signal
    if (signal?.aborted) throw screenshotAbortError()
    if (!/\.(html?|htm)$/i.test(source)) {
      throw new Error('vision_html_screenshot: source must be a local .html/.htm file')
    }
    const fsService = ctx.get('fs')
    if (fsService === undefined) throw new Error('vision_html_screenshot: the fs service is not available')
    // Authorize the exact FsTarget that will be rendered. Do not validate one
    // cwd interpretation and then resolve the same string again under the
    // provider default cwd.
    const resolved = await assertScreenshotSourceInWorkspace(ctx, core, source, exec, { realpathSync: realpath })
    const targetPath = core.toRealPath(fsService, resolved)
    if (!fileExists(targetPath)) throw new Error(`vision_html_screenshot: file not found: ${source}`)

    const targetReal = realpath(targetPath)
    const workspace = realpathOrResolve(workspaceOf(exec), realpath)
    if (!isPathInside(workspace, targetReal)) {
      throw new Error('vision_html_screenshot: source must stay inside the session workspace')
    }
    const sourceRoot = workspace

    const width = safeViewportDimension(args?.width, 1200, MAX_VIEWPORT_WIDTH, 'width')
    const height = safeViewportDimension(args?.height, 720, MAX_VIEWPORT_HEIGHT, 'height')
    const fullPage = args?.fullPage === true
    if (!fullPage && width * height > MAX_SCREENSHOT_PIXELS) {
      throw new Error(`vision_html_screenshot: viewport exceeds the ${MAX_SCREENSHOT_PIXELS} pixel safety limit`)
    }

    let puppeteer
    try {
      puppeteer = await importPuppeteer()
    } catch {
      throw new Error('vision_html_screenshot: puppeteer-core is not installed')
    }
    const candidates = core.chromiumCandidates(
      typeof process !== 'undefined' && process.env ? process.env : {},
      typeof process !== 'undefined' ? process.platform : '',
    )
    const executablePath = candidates.find((candidate) => fileExists(candidate))
    if (executablePath === undefined) {
      throw new Error(
        'vision_html_screenshot: no Chrome/Chromium/Edge found; install one or set CHROME_PATH / PUPPETEER_EXECUTABLE_PATH',
      )
    }

    const releaseBrowserSlot = await browserGovernor.acquire({ signal })
    const launchArgs = ['--disable-gpu', '--hide-scrollbars', '--incognito']
    if (fullPage) launchArgs.push('--blink-settings=imagesLazyLoadingEnabled=false')
    const launcher = puppeteer.default ?? puppeteer
    let browser
    let browserClosePromise
    let abortHandler
    let png
    let pageHeight
    const closeBrowser = () => {
      if (!browser) return Promise.resolve()
      if (!browserClosePromise) {
        browserClosePromise = Promise.resolve(browser.close()).catch(() => undefined)
      }
      return browserClosePromise
    }
    try {
      try {
        browser = await launcher.launch({ executablePath, headless: true, args: launchArgs })
      } catch (error) {
        const detail = error && error.message ? error.message : String(error)
        throw new Error(`vision_html_screenshot: secure Chrome sandbox launch failed: ${detail}`)
      }
      if (signal) {
        abortHandler = () => { void closeBrowser() }
        signal.addEventListener('abort', abortHandler, { once: true })
      }
      if (signal?.aborted) throw screenshotAbortError()

      const page = await browser.newPage()
      await page.setViewport({ width, height })
      // Puppeteer 25 exposes this API. Treat its absence as a hard failure:
      // the tool promises an offline render, so silently degrading would
      // recreate the security gap this boundary exists to close.
      if (typeof page.setOfflineMode !== 'function') {
        throw new Error('vision_html_screenshot: browser offline mode is unavailable')
      }
      await page.setOfflineMode(true)
      await wrapRequestInterception(page, sourceRoot)
      await page.goto(pathToFileURL(targetReal).href, { waitUntil: 'networkidle0', timeout: 30000 })
      if (signal?.aborted) throw screenshotAbortError()

      if (fullPage) {
        pageHeight = await wakePageForFullCaptureBounded(page, height, width, {
          sleep: deps.sleep,
          now: deps.now,
          maxSteps: deps.maxWakeSteps,
          maxWakeMs: deps.maxWakeMs,
        })
      }
      if (signal?.aborted) throw screenshotAbortError()

      png = fullPage
        ? await page.screenshot({ type: 'png', fullPage: true })
        : await page.screenshot({ type: 'png' })
      if (signal?.aborted) throw screenshotAbortError()
    } catch (error) {
      if (signal?.aborted && error?.code !== 'ABORT_ERR') throw screenshotAbortError()
      throw error
    } finally {
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
      try {
        await closeBrowser()
      } finally {
        releaseBrowserSlot()
      }
    }

    // The heavyweight Chrome slot is released before filesystem artifact IO;
    // slow antivirus/indexing must not unnecessarily serialize later captures.
    if (signal?.aborted) throw screenshotAbortError()
    const stem = fullPage ? `shot-${width}x${height}-fullpage` : `shot-${width}x${height}`
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
    const result = { path: target, width, height, bytes: png.length }
    if (fullPage) result.pageHeight = pageHeight
    return JSON.stringify(result)
  }
}

function wrapTools(tools, ctx, core, config) {
  if (!tools || (typeof tools !== 'object' && typeof tools !== 'function')) return tools
  return new Proxy(tools, {
    get(target, property) {
      if (property !== 'register') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      return (def) => {
        if (def?.name === 'vision_html_screenshot' && typeof def.execute === 'function') {
          return register.call(target, {
            ...def,
            execute: createSecureHtmlScreenshotExecute(ctx, core, config),
          })
        }
        return register.call(target, def)
      }
    },
  })
}

export function installAdversarialHardening(ctx, config = {}, core) {
  if (!ctx || typeof ctx !== 'object') return { ctx, config: hardenConfig(config) }
  const hardenedConfig = hardenConfig(config)
  const wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return wrapTools(target.tools, wrapped, core, hardenedConfig)
      if (property === 'effect') {
        const effect = Reflect.get(target, property, target)
        if (typeof effect !== 'function') return effect
        return (factory, label) => {
          if (label !== 'vision-router: proxy fetch') return effect.call(target, factory, label)
          return effect.call(target, () => {
            const originalFetch = globalThis.fetch
            const disposer = factory()
            let installedFetch = globalThis.fetch
            let active = true
            // Later plugins may capture this function. Making it an inert
            // delegator on unload removes Vision Router from the chain even if
            // another plugin still sits above it, and prevents it resurfacing
            // when that later plugin restores the fetch value it captured.
            const guardedFetch = (...args) => {
              const fetchImpl = active && typeof installedFetch === 'function'
                ? installedFetch
                : originalFetch
              return fetchImpl(...args)
            }
            globalThis.fetch = guardedFetch
            return () => {
              if (!active) return
              active = false
              // Drop the raw Vision Router fetch closure as soon as ownership
              // ends. This releases its cached ProxyAgent/undici closure even
              // when a later plugin still retains guardedFetch.
              installedFetch = undefined
              const currentFetch = globalThis.fetch
              try {
                // Always run the underlying effect disposer. It may own more
                // than the process-level pointer; skipping it merely because a
                // later plugin wrapped fetch leaks that lifecycle forever.
                if (typeof disposer === 'function') disposer()
              } finally {
                // The core disposer currently restores originalFetch
                // unconditionally. Preserve any later plugin that was above us,
                // while an outermost Vision Router cleanup returns to the host.
                globalThis.fetch = currentFetch === guardedFetch
                  ? originalFetch
                  : currentFetch
              }
            }
          }, label)
        }
      }
      // Deliberately do NOT wrap ctx.inject or injected child contexts. DSH
      // rc.6 ties route/effect ownership to the exact child-context identity;
      // replacing it with a Proxy previously made host routes disappear (#160).
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { ctx: wrapped, config: hardenedConfig }
}
