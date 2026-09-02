import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { writeArtifactFile } from './artifact-boundary.js'
import {
  createGroundingFrame,
  groundingFrameBoxToSource,
} from './grounding-coordinate-frame.js'

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

function boxSvg(box, width, height, number) {
  const stroke = Math.max(2, Math.round(Math.min(width, height) / 300))
  const x = Math.max(0, box.x1)
  const y = Math.max(0, box.y1)
  const w = Math.max(1, box.x2 - box.x1)
  const h = Math.max(1, box.y2 - box.y1)
  if (number === undefined) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ff3b30" stroke-width="${stroke}"/>`
  }
  const fontSize = Math.max(14, Math.round(Math.min(width, height) / 35))
  const labelWidth = Math.max(fontSize * 1.4, String(number).length * fontSize * 0.8)
  const labelHeight = Math.round(fontSize * 1.25)
  const labelY = Math.max(0, y - labelHeight)
  return [
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ff3b30" stroke-width="${stroke}"/>`,
    `<rect x="${x}" y="${labelY}" width="${labelWidth}" height="${labelHeight}" fill="#ff3b30"/>`,
    `<text x="${x + Math.round(fontSize * 0.25)}" y="${labelY + fontSize}" font-size="${fontSize}" font-family="sans-serif" fill="white">${number}</text>`,
  ].join('')
}

async function annotateSource(bytes, width, height, boxes) {
  const sharp = await loadSharp()
  const markup = boxes
    .map((box, index) => boxSvg(box, width, height, boxes.length === 1 ? undefined : index + 1))
    .join('')
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${markup}</svg>`,
  )
  return sharp(bytes, { failOn: 'none' })
    .composite([{ input: svg, left: 0, top: 0 }])
    .png()
    .toBuffer()
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
        const annotated = await annotateSource(bytes, width, height, [mapped])
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
      const annotated = await annotateSource(bytes, width, height, elements.map((item) => item.box))
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
 * pixels. Core still owns provider selection, fallback, retry and failure
 * semantics; this boundary owns only raster geometry and original-image
 * annotation.
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
      return (def, ...rest) => register.call(
        target,
        wrapGroundingDefinition(ctx, options, def),
        ...rest,
      )
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
