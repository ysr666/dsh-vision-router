import z from '@deepseek-ai/schemastery'
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { appendPromptToImageOnlyMessage, fetchWithOpenAICompatibility } from './http-compat.js'
import {
  directSessionAffinityHeaders,
  isOfficialOpenCodeGoUrl,
  openCodeSessionAffinityHeaderForUrl,
  rawSessionIdentity,
  sessionIdentityOf,
} from './session-affinity.js'
import { runWithVisionSessionAffinity, streamWithVisionSessionAffinity } from './session-affinity-runtime.js'
import {
  routingCorrectionFor,
  toAnthropicMessages,
  callAnthropicCompatible,
  anthropicMediaType,
} from './catalog-corrections.js'
import { createCachedUpdateChecker } from './update-check.js'
import { probeLocalBackends } from './local-connection-probe.js'
import { detectDshSelfUpdatePlan, runDshPluginUpdate } from './self-update.js'
import {
  classifyVisionFailure,
  createDeadline,
  combineSignals,
  createVisionCircuitBreaker,
  createVisionTurnMemory,
  buildVisionFailure,
  ensureSentencePunctuation,
  resultCodeForKinds,
  qwenKeyEndpointHint,
  kindForHttpStatus,
  VISION_FAILURE_KINDS,
  VISION_RESULT_CODES,
} from './vision-resilience.js'
import { currentVisionExecutionOrder } from './vision-execution-order.js'
import { applyVisionExecutionOrder } from './vision-execution-order-apply.js'
import { createHash, randomBytes } from 'node:crypto'
import {
  normalizeStructuredBootstrapResult,
  structuredBootstrapMemory,
  structuredBootstrapQuestion,
} from './structured-bootstrap.js'
import { planMixedBranches, renderMixedGuidance } from './mixed-router.js'
import { renderDepthGuidance } from './depth-guidance.js'
import { assertNoRepetitionLoop } from './repetition-guard.js'
import { compareRgbaStreams } from './pixel-diff-stream.js'
import {
  boundedOcrTiles,
  defaultImageResourceGovernor,
  estimateImageOperationBytes,
  scaleBox,
  scaledDimensions,
} from './image-resource-governor.js'
import { createSessionVisionIndex } from './session-vision-index.js'
import { createSessionVisionStateStore } from './session-vision-state.js'
import {
  ERROR_RESPONSE_MAX_BYTES,
  METADATA_RESPONSE_MAX_BYTES,
  MODEL_RESPONSE_MAX_BYTES,
  readResponseJsonBounded,
  readResponseTextBounded,
} from './http-body-limit.js'
import { writeArtifactFile } from './artifact-boundary.js'
import { stripTrailingSlashes } from './string-normalization.js'
import { parseVersionComparator } from './version-range.js'
import { captureWindowsDesktop } from './windows-desktop-capture.js'

// sharp is a native module with platform-specific prebuilt binaries. It used
// to be imported statically, so a missing, broken, or conflicting install
// (e.g. a second sharp version alongside the harness's own) would throw at
// module load and could take the whole `dsh web` profile down at boot. Load it
// lazily and cache the resolved factory so a sharp failure degrades only the
// pixel-level tools — the routing chain and text tools keep working.
let sharpPromise
// Module-level warning sink installed by apply(): the plugin routes runtime
// diagnostics through ctx.logger instead of console.warn. Kept as a plain
// function slot so loadSharp() stays usable outside a Cordis context (tests,
// the doctor CLI).
let sharpWarningHook
export function registerSharpWarningHook(hook) {
  sharpWarningHook = typeof hook === 'function' ? hook : undefined
}

function warnSharp(message) {
  if (sharpWarningHook !== undefined) {
    try {
      sharpWarningHook(message)
      return
    } catch {
      /* fall through to console */
    }
  }
  if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(message)
}

/** Split "1.2.3" / "1.2" / "1" / "1.2.3-beta.4" into comparable parts
 * (missing minor/patch default to 0, like semver). */
export function parseVersionParts(version) {
  const match = String(version ?? '').trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/)
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    pre: match[4],
  }
}

function compareVersionParts(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  // A prerelease sorts below its release: 0.35.3-beta < 0.35.3.
  if (a.pre === undefined && b.pre === undefined) return 0
  if (a.pre === undefined) return 1
  if (b.pre === undefined) return -1
  return a.pre < b.pre ? -1 : a.pre > b.pre ? 1 : 0
}

/**
 * Minimal semver range check for the comparator shapes the plugin itself
 * declares (`>=0.35.3 <1`, space-separated clauses, `||` alternatives).
 * @returns true when `version` satisfies `range`, false otherwise (also for
 * malformed inputs, so an unparsable range fails safe and loud).
 */
export function versionSatisfies(version, range) {
  const parts = parseVersionParts(version)
  if (parts === undefined) return false
  const alternatives = String(range ?? '')
    .split('||')
    .map((alt) => alt.trim())
    .filter((alt) => alt !== '')
  if (alternatives.length === 0) return false
  return alternatives.some((alternative) => {
    const clauses = alternative.split(/\s+/)
    if (clauses.length === 0) return false
    return clauses.every((clause) => {
      const comparator = parseVersionComparator(clause)
      if (comparator === undefined) return false
      const { op } = comparator
      const other = parseVersionParts(comparator.version)
      if (other === undefined) return false
      const cmp = compareVersionParts(parts, other)
      switch (op) {
        case '>=': return cmp >= 0
        case '<=': return cmp <= 0
        case '>': return cmp > 0
        case '<': return cmp < 0
        default: return cmp === 0
      }
    })
  })
}

// Read the plugin's own peerDependencies.sharp range from the installed
// package.json (createRequire resolves it relative to this file, so the value
// is never hardcoded and follows package.json through releases).
let sharpPeerRangeCache
function sharpPeerRange() {
  if (sharpPeerRangeCache === undefined) {
    try {
      const requireLocal = createRequire(import.meta.url)
      const pkg = requireLocal('../package.json')
      sharpPeerRangeCache =
        pkg && pkg.peerDependencies && typeof pkg.peerDependencies.sharp === 'string'
          ? pkg.peerDependencies.sharp
          : undefined
    } catch {
      sharpPeerRangeCache = undefined
    }
  }
  return sharpPeerRangeCache
}

function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((mod) => {
        const sharp = mod.default ?? mod
        // issue #75: an upgrade from v1.1.x can leave a stale sharp 0.34.0 in
        // the profile's node_modules; pnpm does not physically remove orphaned
        // peer copies on upgrade. On Windows the stale copy's libvips DLL and
        // the host's coexist in one process and every pixel tool then dies
        // with the cryptic "colourspace: parameter space not set". Detect the
        // violation up front and turn it into an actionable warning.
        try {
          const version = sharp && sharp.versions && typeof sharp.versions.sharp === 'string'
            ? sharp.versions.sharp
            : undefined
          const range = sharpPeerRange()
          if (version !== undefined && range !== undefined && !versionSatisfies(version, range)) {
            warnSharp(
              `dsh-vision-router: the resolved sharp ${version} does not satisfy the plugin peer range "${range}". ` +
                'This is usually a stale sharp left in the profile from a pre-v1.2 upgrade: remove ' +
                '`<profile>/node_modules/sharp` and `<profile>/node_modules/@img` (or run `pnpm install` in the profile) ' +
                'and restart, so the plugin falls through to the host sharp. Until then, pixel tools may fail with ' +
                '"colourspace: parameter space not set".',
            )
          }
        } catch {
          /* diagnostics must never break the pixel tools */
        }
        return sharp
      })
      .catch((cause) => {
        sharpPromise = undefined // allow a retry after the environment is repaired
        const error = new Error(
          'dsh-vision-router: the sharp image library is unavailable, so the pixel-level ' +
            'vision tools are disabled. Reinstall the plugin dependencies (or run the doctor) to restore them.',
        )
        error.cause = cause
        throw error
      })
  }
  return sharpPromise
}

export {
  sharpPromise,
  sharpWarningHook,
  warnSharp,
  compareVersionParts,
  sharpPeerRangeCache,
  sharpPeerRange,
  loadSharp,
}
