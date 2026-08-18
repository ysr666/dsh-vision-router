import { existsSync, realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_ARTIFACTS_DIR = '.dsh-vision-router/artifacts'
const MAX_VIEWPORT_WIDTH = 4096
const MAX_VIEWPORT_HEIGHT = 4096
const MAX_SCREENSHOT_PIXELS = 50_000_000

const wrappedTools = new WeakMap()

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

function realpathOrResolve(value) {
  try {
    return realpathSync(value)
  } catch {
    return path.resolve(value)
  }
}

function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return isNonEmptyString(cwd) ? cwd : process.cwd()
}

function artifactDirectory(exec, configured) {
  const workspace = realpathOrResolve(workspaceOf(exec))
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
  try {
    filePath = realpathSync(fileURLToPath(url))
  } catch {
    return false
  }
  return isPathInside(allowedRoot, filePath)
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

export function createSecureHtmlScreenshotExecute(ctx, core, config, deps = {}) {
  const importPuppeteer = deps.importPuppeteer ?? (() => import('puppeteer-core'))
  const fileExists = deps.existsSync ?? existsSync
  const makeDir = deps.mkdir ?? mkdir
  const saveFile = deps.writeFile ?? writeFile
  const realpath = deps.realpathSync ?? realpathSync

  return async (args, exec) => {
    const source = String(args?.source ?? '')
    if (!/\.(html?|htm)$/i.test(source)) {
      throw new Error('vision_html_screenshot: source must be a local .html/.htm file')
    }
    const fsService = ctx.get('fs')
    if (fsService === undefined) throw new Error('vision_html_screenshot: the fs service is not available')
    const resolved = await fsService.resolve(source)
    const targetPath = core.toRealPath(fsService, resolved)
    if (!fileExists(targetPath)) throw new Error(`vision_html_screenshot: file not found: ${source}`)

    const targetReal = realpath(targetPath)
    const workspace = realpathOrResolve(workspaceOf(exec))
    const sourceRoot = isPathInside(workspace, targetReal) ? workspace : realpath(path.dirname(targetReal))

    const width = safeViewportDimension(args?.width, 1200, MAX_VIEWPORT_WIDTH, 'width')
    const height = safeViewportDimension(args?.height, 720, MAX_VIEWPORT_HEIGHT, 'height')
    const fullPage = args?.fullPage === true

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

    const launchArgs = ['--disable-gpu', '--hide-scrollbars', '--incognito']
    if (fullPage) launchArgs.push('--blink-settings=imagesLazyLoadingEnabled=false')
    const launcher = puppeteer.default ?? puppeteer
    let browser
    try {
      browser = await launcher.launch({ executablePath, headless: true, args: launchArgs })
    } catch (error) {
      const detail = error && error.message ? error.message : String(error)
      throw new Error(`vision_html_screenshot: secure Chrome sandbox launch failed: ${detail}`)
    }

    try {
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

      let pageHeight
      if (fullPage) {
        pageHeight = await page.evaluate(() => Math.max(
          document.documentElement?.scrollHeight ?? 0,
          document.body?.scrollHeight ?? 0,
        ))
        if (!Number.isFinite(pageHeight) || pageHeight <= 0 || width * pageHeight > MAX_SCREENSHOT_PIXELS) {
          throw new Error(
            `vision_html_screenshot: full-page capture exceeds the ${MAX_SCREENSHOT_PIXELS} pixel safety limit`,
          )
        }
      } else if (width * height > MAX_SCREENSHOT_PIXELS) {
        throw new Error(`vision_html_screenshot: viewport exceeds the ${MAX_SCREENSHOT_PIXELS} pixel safety limit`)
      }

      const png = fullPage
        ? await page.screenshot({ type: 'png', fullPage: true })
        : await page.screenshot({ type: 'png' })
      const stem = fullPage ? `shot-${width}x${height}-fullpage` : `shot-${width}x${height}`
      const dir = artifactDirectory(exec, config.artifactsDir)
      await makeDir(dir, { recursive: true })
      const target = path.join(dir, `${core.artifactStemOf(source, stem)}.png`)
      if (!isPathInside(dir, target)) throw new Error('vision_html_screenshot: unsafe artifact target')
      await saveFile(target, png)
      const result = { path: target, width, height, bytes: png.length }
      if (fullPage) result.pageHeight = pageHeight
      return JSON.stringify(result)
    } finally {
      await browser.close()
    }
  }
}

function wrapTools(tools, ctx, core, config) {
  if (!tools || (typeof tools !== 'object' && typeof tools !== 'function')) return tools
  const cached = wrappedTools.get(tools)
  if (cached) return cached
  const wrapped = new Proxy(tools, {
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
  wrappedTools.set(tools, wrapped)
  return wrapped
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
            const installedFetch = globalThis.fetch
            let active = true
            // Later plugins may capture this function. Making it an inert
            // delegator on unload removes Vision Router from the chain even if
            // another plugin still sits above it, and prevents it resurfacing
            // when that later plugin restores the fetch value it captured.
            const guardedFetch = (...args) => active
              ? installedFetch(...args)
              : originalFetch(...args)
            globalThis.fetch = guardedFetch
            return () => {
              active = false
              if (globalThis.fetch === guardedFetch) {
                globalThis.fetch = originalFetch
                // The core disposer is safe only while our guard is still the
                // active process-level fetch. Never let its unconditional
                // assignment clobber a later plugin's patch.
                if (typeof disposer === 'function') disposer()
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
