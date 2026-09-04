import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { writeArtifactFile } from './artifact-boundary.js'
import {
  createGroundingFrame,
  groundingFrameBoxToSource,
} from './grounding-coordinate-frame.js'
import { wrapVisionAttachmentHandleDefinition } from './vision-attachment-handle-runtime.js'

const GROUNDING_TOOL_NAMES = new Set(['vision_ground', 'vision_detect'])
let sharpPromise

function loadSharp() {
  if (!sharpPromise) {
    sharpPromise = import('sharp').then((mod) => mod.default ?? mod).catch((error) => {
      sharpPromise = undefined
      throw error
    })
  }
  return sharpPromise
}

function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

function artifactsDirOf(config) {
  return typeof config?.artifactsDir === 'string' && config.artifactsDir !== ''
    ? config.artifactsDir
    : '.dsh-vision-router/artifacts'
}

function contextService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get(name)
  } catch {
    return undefined
  }
  return ctx?.[name]
}

async function readSourceBytes(ctx, core, sessionVisionIndex, exec, image) {
  const source = String(image ?? '')
  if (core?.isAttachmentIdInput?.(source)) {
    const session = exec?.agent?.session
    const ref = sessionVisionIndex?.lookupAttachment?.(session, source.trim())
    if (ref === undefined) {
      throw new Error(
        `vision-router: unknown attachment id "${source}" (it must come from an image uploaded in this conversation)`,
      )
    }
    const attachments = contextService(ctx, 'attachments')
    if (!attachments || typeof attachments.readImage !== 'function') {
      throw new Error('vision-router: the attachment service is not available in this deployment')
    }
    const stored = await attachments.readImage(ref, exec?.signal)
    if (!stored?.data) throw new Error(`vision-router: failed to read attachment ${source}`)
    return Buffer.from(stored.data)
  }

  const fs = contextService(ctx, 'fs')
  if (!fs || typeof fs.resolve !== 'function' || typeof fs.readBytes !== 'function') {
    throw new Error('vision-router: the fs service is not available')
  }
  const target = await fs.resolve(source)
  return Buffer.from(await fs.readBytes(target, undefined, 20 * 1024 * 1024))
}

async function buildGroundingFrame(bytes) {
  const sharp = await loadSharp()
  const meta = await sharp(bytes, { failOn: 'none' }).metadata()
  const width = Number(meta.width ?? 0)
  const height = Number(meta.height ?? 0)
  if (width <= 0 || height <= 0) throw new Error('could not read image dimensions')
  const frame = createGroundingFrame(width, height)
  const framed = await sharp(bytes, { failOn: 'none' })
    .resize(frame.renderedWidth, frame.renderedHeight, { fit: 'fill' })
    .extend({
      top: frame.top,
      bottom: frame.bottom,
      left: frame.left,
      right: frame.right,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    })
    .png()
    .toBuffer()
  return { frame, framed, width, height }
}

function parseToolResult(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function removeInternalFrame(workspace, publishedPath) {
  if (typeof publishedPath !== 'string' || publishedPath === '') return
  const target = path.isAbsolute(publishedPath) ? publishedPath : path.resolve(workspace, publishedPath)
  try {
    await unlink(target)
  } catch {
    // The internal frame is best-effort cleanup. Artifact retention may already
    // have removed it after the delegated tool completed.
  }
}

async function executeInGroundingFrame({
  ctx,
  core,
  config,
  sessionVisionIndex,
  def,
  execute,
  args,
  exec,
}) {
  const source = String(args?.image ?? '')
  const bytes = await readSourceBytes(ctx, core, sessionVisionIndex, exec, source)
  const { frame, framed, width, height } = await buildGroundingFrame(bytes)
  const workspace = workspaceOf(exec)
  const artifactsDir = artifactsDirOf(config)
  const internalName = `.grounding-frame-${randomUUID()}.png`
  const framePath = await writeArtifactFile(workspace, artifactsDir, internalName, framed)

  try {
    const raw = await execute(
      {
        ...(args ?? {}),
        image: framePath,
        // Core's annotation would be in the protocol frame. Re-publish only an
        // original-raster annotation after the deterministic inverse transform.
        annotate: false,
      },
      exec,
    )
    const delegated = parseToolResult(raw)
    if (!delegated || delegated.ok === false) return raw

    if (def.name === 'vision_ground') {
      const mapped = groundingFrameBoxToSource(delegated, frame)
      if (!mapped) {
        throw new Error('vision_ground: the model box falls entirely outside the letterboxed source raster')
      }
      const result = { ...mapped, width, height }
      if (args?.annotate !== false) {
        if (typeof core?.annotateBoxBuffer !== 'function') {
          throw new Error('vision_ground: core annotation helper is unavailable')
        }
        const annotated = await core.annotateBoxBuffer(bytes, mapped)
        const stem = core?.artifactStemOf?.(source, 'ground') ?? `image-ground-${Date.now()}`
        result.annotatedPath = await writeArtifactFile(workspace, artifactsDir, `${stem}.png`, annotated)
      }
      return JSON.stringify(result)
    }

    const elements = []
    for (const item of Array.isArray(delegated.elements) ? delegated.elements : []) {
      const mapped = groundingFrameBoxToSource(item?.box, frame)
      if (!mapped) continue
      elements.push({
        ...item,
        number: elements.length + 1,
        box: mapped,
      })
    }
    const result = { width, height, elements }
    if (args?.annotate !== false && elements.length > 0) {
      if (typeof core?.annotateBoxesBuffer !== 'function') {
        throw new Error('vision_detect: core annotation helper is unavailable')
      }
      const annotated = await core.annotateBoxesBuffer(bytes, elements.map((item) => item.box))
      const stem = core?.artifactStemOf?.(source, 'detect') ?? `image-detect-${Date.now()}`
      result.annotatedPath = await writeArtifactFile(workspace, artifactsDir, `${stem}.png`, annotated)
    }
    return JSON.stringify(result)
  } finally {
    await removeInternalFrame(workspace, framePath)
  }
}

function wrapGroundingDefinition(ctx, options, def) {
  if (!def || !GROUNDING_TOOL_NAMES.has(def.name) || typeof def.execute !== 'function') return def
  const execute = def.execute
  return {
    ...def,
    execute(args, exec) {
      return executeInGroundingFrame({
        ctx,
        ...options,
        def,
        execute,
        args,
        exec,
      })
    },
  }
}

/**
 * Give vision_ground / vision_detect one explicit provider-independent
 * coordinate protocol: the model always receives an exact 1000x1000
 * letterboxed raster, while callers always receive Host-canonical source
 * pixels. The same registration seam also canonicalizes DSH text-only image
 * handles before any Vision Router tool sees them, so short model-facing
 * sha256 prefixes can never fall through into filesystem-path resolution.
 * Core still owns provider selection, fallback, retry and failure semantics.
 */
export function contextWithGroundingCoordinateFrame(ctx, options = {}) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return ctx
  const sourceTools = ctx.tools ?? contextService(ctx, 'tools')
  if (!sourceTools || typeof sourceTools.register !== 'function') return ctx

  const tools = new Proxy(sourceTools, {
    get(target, property) {
      if (property !== 'register') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      return (def, ...rest) => {
        const grounded = wrapGroundingDefinition(ctx, options, def)
        const attachmentResolved = wrapVisionAttachmentHandleDefinition(grounded, options)
        return register.call(target, attachmentResolved, ...rest)
      }
    },
  })

  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return tools
      if (property === 'get') {
        const get = Reflect.get(target, property, target)
        if (typeof get !== 'function') return get
        return (name, ...rest) => name === 'tools' ? tools : get.call(target, name, ...rest)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
