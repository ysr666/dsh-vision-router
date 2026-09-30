import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  callLocalBackend,
  localDescribePrompt,
  localProvidersOf,
  toOpenAIContent,
} from './core-primitives.js'
import { loadSharp } from './sharp-runtime.js'
import { captureWindowsDesktop } from './windows-desktop-capture.js'

async function captureDesktopPng(target, timeoutMs, signal) {
  const platform = process.platform
  if (platform === 'win32') {
    // Own DPI-aware capture at the implementation boundary rather than
    // depending on a process-wide execFile argument rewrite.
    await captureWindowsDesktop(target, { timeoutMs, signal })
    return platform
  }
  if (platform === 'darwin') {
    // Without -m, screencapture writes one file per display while the tool owns
    // exactly one artifact path, so request the main display explicitly.
    await promisify(execFile)('screencapture', ['-x', '-m', target], {
      timeout: timeoutMs,
      windowsHide: true,
    })
    return platform
  }
  try {
    await promisify(execFile)('import', ['-window', 'root', target], { timeout: timeoutMs })
  } catch {
    await promisify(execFile)('scrot', [target], { timeout: timeoutMs })
  }
  return platform
}

async function downscaleForIdentification(data) {
  try {
    const sharp = await loadSharp()
    if (!sharp) return data
    const downscaled = await sharp(data, { failOn: 'none' })
      .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
    return downscaled.length > 0 && downscaled.length < data.length ? downscaled : data
  } catch {
    return data
  }
}

async function identifyDesktopCapture(data, {
  current,
  timeoutMs,
  instantLocalStyle,
  providerTransport,
} = {}) {
  const locals = localProvidersOf(current())
  if (locals.length === 0) {
    return {
      identifyError: 'no local vision backend enabled (localOllama / localLmStudio); enable one to use identify',
    }
  }

  const startedAt = Date.now()
  const identifyBytes = await downscaleForIdentification(data)
  const result = {}
  if (identifyBytes !== data) {
    result.identifyDownscaled = {
      originalBytes: data.length,
      sentBytes: identifyBytes.length,
    }
  }

  const content = toOpenAIContent(
    [{ type: 'image', attachment: { mediaType: 'image/png', data: identifyBytes } }],
    () => identifyBytes,
  )
  content.push({ type: 'text', text: localDescribePrompt(instantLocalStyle()) })

  const deadlineAt = Date.now() + timeoutMs()
  const errors = []
  for (let index = 0; index < locals.length; index++) {
    const local = locals[index]
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) break
    // Reserve a fair share for later local backends. A connected but hung
    // first backend must not consume the entire fallback budget.
    const roundBudgetMs = Math.max(1, Math.floor(remainingMs / (locals.length - index)))
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), roundBudgetMs)
    try {
      const identified = await callLocalBackend(
        local,
        [{ role: 'user', content }],
        {
          maxTokens: local.maxTokens ?? 2048,
          signal: controller.signal,
          providerTransport,
        },
      )
      if (typeof identified === 'string' && identified.trim() !== '') {
        result.identified = identified.trim()
        result.identifiedBy = local.name
        result.elapsedSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
        return result
      }
      errors.push(`${local.name}: empty response`)
    } catch (error) {
      errors.push(`${local.name}: ${error && error.message ? error.message : String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  result.identifyError = errors.length > 0
    ? errors.join('; ').slice(0, 1000)
    : 'local vision identification timed out before a backend could respond'
  return result
}

/**
 * Build the privacy-sensitive desktop screenshot tool definition.
 *
 * Tool registration/exposure remains owned by Core + LocalVisionStabilizer;
 * this module owns only the platform capture and optional local-recognition
 * implementation behind that existing permission boundary.
 */
export function createDesktopScreenshotTool({
  current,
  timeoutMs,
  saveArtifact,
  stringOutput,
  instantLocalStyle,
  providerTransport,
} = {}) {
  if (typeof current !== 'function' || typeof timeoutMs !== 'function' || typeof saveArtifact !== 'function') {
    throw new TypeError('desktop screenshot tool requires live config, timeout and artifact callbacks')
  }
  if (typeof instantLocalStyle !== 'function') {
    throw new TypeError('desktop screenshot tool requires a live local describe style')
  }

  return {
    name: 'vision_screenshot',
    description:
      'Capture the user\'s desktop screen as a PNG artifact (the virtual screen on Windows; the main display on macOS; the root display on Linux). ' +
      'Windows: per-monitor-DPI-aware PowerShell capture; macOS: screencapture; Linux: ImageMagick import (falls back to scrot; either command must be installed). ' +
      'This privacy-sensitive tool is disabled by default and works only after the user explicitly enables Desktop screenshot in Vision Router settings. ' +
      'Use it when you need to see what is on the user\'s screen right now — e.g. their current GUI, an app, or a page outside this browser. ' +
      'Optional identify=true also runs local recognition on the capture using the enabled local backends (Ollama, then LM Studio) and returns the description alongside the path.',
    parameters: {
      type: 'object',
      properties: {
        identify: {
          type: 'boolean',
          description:
            'Also recognize the captured screen with enabled local vision backends (Ollama, then LM Studio) and return the description text with the path. Default false.',
        },
      },
      additionalProperties: false,
    },
    output: stringOutput,
    async execute(args, exec) {
      if (current().desktopScreenshot !== true) {
        throw new Error(
          'vision_screenshot is disabled; enable Desktop screenshot explicitly in Vision Router settings before use',
        )
      }

      const tmp = path.join(
        tmpdir(),
        `vision-screenshot-${Date.now()}-${Math.floor(Math.random() * 1e9)}.png`,
      )
      try {
        const platform = await captureDesktopPng(tmp, timeoutMs(), exec?.signal)
        if (!existsSync(tmp)) {
          throw new Error(
            `vision_screenshot: no output produced on ${platform} (is a screen available?)`,
          )
        }
        const data = await readFile(tmp)
        const target = await saveArtifact(exec, `screenshot-${Date.now()}.png`, data)
        const result = { path: target, bytes: data.length }
        if (args.identify === true) {
          Object.assign(result, await identifyDesktopCapture(data, {
            current,
            timeoutMs,
            instantLocalStyle,
            providerTransport,
          }))
        }
        return JSON.stringify(result)
      } finally {
        try { await unlink(tmp) } catch { /* best effort cleanup */ }
      }
    },
  }
}
