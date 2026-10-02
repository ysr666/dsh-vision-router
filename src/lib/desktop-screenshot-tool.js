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
import { currentVisionTurnBudgetSignal } from './turn-budget-context.js'
import { combineSignals } from './vision-resilience.js'

function abortReason(signal, fallback = 'vision_screenshot aborted') {
  if (signal?.reason instanceof Error) return signal.reason
  const error = new Error(fallback)
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal)
}

function isAbortFailure(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

export async function captureDesktopPng(target, timeoutMs, signal, options = {}) {
  const platform = options.platform ?? process.platform
  const run = options.execFileAsync ?? promisify(execFile)
  const captureWindows = options.captureWindowsDesktop ?? captureWindowsDesktop
  throwIfAborted(signal)
  if (platform === 'win32') {
    // Own DPI-aware capture at the implementation boundary rather than
    // depending on a process-wide execFile argument rewrite.
    await captureWindows(target, { timeoutMs, signal })
    throwIfAborted(signal)
    return platform
  }
  if (platform === 'darwin') {
    // Without -m, screencapture writes one file per display while the tool owns
    // exactly one artifact path, so request the main display explicitly.
    await run('screencapture', ['-x', '-m', target], {
      timeout: timeoutMs,
      windowsHide: true,
      ...(signal === undefined ? {} : { signal }),
    })
    throwIfAborted(signal)
    return platform
  }
  try {
    await run('import', ['-window', 'root', target], {
      timeout: timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (signal?.aborted || isAbortFailure(error)) throw error
    await run('scrot', [target], {
      timeout: timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    })
  }
  throwIfAborted(signal)
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
  signal,
} = {}) {
  throwIfAborted(signal)
  const locals = localProvidersOf(current())
  if (locals.length === 0) {
    return {
      identifyError: 'no local vision backend enabled (localOllama / localLmStudio); enable one to use identify',
    }
  }

  const startedAt = Date.now()
  const identifyBytes = await downscaleForIdentification(data)
  throwIfAborted(signal)
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
    throwIfAborted(signal)
    const local = locals[index]
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) break
    // Reserve a fair share for later local backends. A connected but hung
    // first backend must not consume the entire fallback budget.
    const roundBudgetMs = Math.max(1, Math.floor(remainingMs / (locals.length - index)))
    const controller = new AbortController()
    const roundSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal
    const timer = setTimeout(() => controller.abort(), roundBudgetMs)
    try {
      const identified = await callLocalBackend(
        local,
        [{ role: 'user', content }],
        {
          maxTokens: local.maxTokens ?? 2048,
          signal: roundSignal,
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
      if (signal?.aborted) throw abortReason(signal)
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
  captureDesktop = captureDesktopPng,
} = {}) {
  if (
    typeof current !== 'function' ||
    typeof timeoutMs !== 'function' ||
    typeof saveArtifact !== 'function' ||
    typeof captureDesktop !== 'function'
  ) {
    throw new TypeError('desktop screenshot tool requires live config, timeout, artifact and capture callbacks')
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
        const signal = combineSignals(currentVisionTurnBudgetSignal(), exec?.signal)
        throwIfAborted(signal)
        const platform = await captureDesktop(tmp, timeoutMs(), signal)
        throwIfAborted(signal)
        if (!existsSync(tmp)) {
          throw new Error(
            `vision_screenshot: no output produced on ${platform} (is a screen available?)`,
          )
        }
        const data = await readFile(tmp, signal === undefined ? undefined : { signal })
        throwIfAborted(signal)
        let identification
        if (args.identify === true) {
          identification = await identifyDesktopCapture(data, {
            current,
            timeoutMs,
            instantLocalStyle,
            providerTransport,
            signal,
          })
        }
        // Artifact publication is the final commit point. If optional local
        // identification is cancelled, no successful screenshot result should
        // already have escaped into the managed artifact store.
        throwIfAborted(signal)
        const target = await saveArtifact(exec, `screenshot-${Date.now()}.png`, data)
        return JSON.stringify({
          path: target,
          bytes: data.length,
          ...(identification ?? {}),
        })
      } finally {
        try { await unlink(tmp) } catch { /* best effort cleanup */ }
      }
    },
  }
}
