import { readFile, writeFile } from 'node:fs/promises'

const phase = process.argv[2]
const file = new URL('../index.js', import.meta.url)
let source = await readFile(file, 'utf8')

function replaceOnce(label, before, after) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`)
  source = source.replace(before, after)
}

function insertAfter(label, anchor, insertion) {
  replaceOnce(label, anchor, `${anchor}${insertion}`)
}

function statePhase() {
  insertAfter(
    'session state import',
    "import { assertNoRepetitionLoop } from './lib/repetition-guard.js'\n",
    "import { createSessionVisionStateStore } from './lib/session-vision-state.js'\n",
  )
  replaceOnce(
    'global image memory',
    `  // attachmentId -> description captured from a successful vision turn, so\n  // later text turns can replace stripped image blocks with real knowledge.\n  const imageMemory = new Map()`,
    `  // #208: cross-turn visual knowledge belongs to a bounded session owner,\n  // not to the plugin process. The compatibility facade is used only at\n  // adapter boundaries that do not expose a Session; ambiguous attachment ids\n  // deliberately miss instead of crossing conversations.\n  const visionState = createSessionVisionStateStore({\n    maxSessions: 64,\n    idleTtlMs: 60 * 60 * 1000,\n    descriptionMaxEntries: 64,\n    descriptionMaxChars: 256 * 1024,\n    attachmentMaxEntries: 256,\n  })\n  const imageMemory = visionState.descriptionFacade`,
  )
  replaceOnce(
    'legacy attachment maps',
    `  // session -> Map<attachmentId, ref> (uploaded images visible to vision_describe)\n  const sessionAttachments = new WeakMap()\n  // secondary index by session id string (agent.session object identity can change across turns)\n  const sessionAttachmentsById = new Map()\n`,
    `  // #208: attachment refs, description memory and the event-log cursor are\n  // owned by the same bounded SessionVisionStateStore above.\n`,
  )
  replaceOnce(
    'record attachments',
    `  const recordUploadedAttachments = (session, attachments) => {\n    if (!session || !Array.isArray(attachments) || attachments.length === 0) return\n    let map = sessionAttachments.get(session)\n    if (!map) {\n      map = new Map()\n      sessionAttachments.set(session, map)\n    }\n    let byId\n    if (session.id !== undefined) {\n      byId = sessionAttachmentsById.get(String(session.id))\n      if (!byId) {\n        byId = new Map()\n        sessionAttachmentsById.set(String(session.id), byId)\n      }\n    }\n    for (const ref of attachments) {\n      if (ref && ref.attachmentId) {\n        map.set(String(ref.attachmentId), ref)\n        byId?.set(String(ref.attachmentId), ref)\n      }\n    }\n  }\n\n  // session id -> event-log length already scanned for attachment refs.\n  // Mirrors sessionAttachmentsById: sessions are long-lived objects, and only\n  // the id string survives a process resume, so the index is keyed by id.\n  const scannedSessionEventSeqs = new Map()`,
    `  const recordUploadedAttachments = (session, attachments) => {\n    visionState.recordAttachments(session, attachments)\n  }`,
  )
  replaceOnce(
    'event cursor read',
    `    const key = session.id !== undefined ? String(session.id) : undefined\n    const last = key !== undefined ? (scannedSessionEventSeqs.get(key) ?? 0) : 0\n    if (last >= events.length) return\n    const refs = collectEventAttachmentRefs(events.slice(last))\n    if (key !== undefined) scannedSessionEventSeqs.set(key, events.length)`,
    `    const last = visionState.getScannedEventSeq(session)\n    if (last >= events.length) return\n    const refs = collectEventAttachmentRefs(events.slice(last))\n    visionState.setScannedEventSeq(session, events.length)`,
  )
  replaceOnce(
    'attachment lookup',
    `  const lookupAttachment = (session, id) => {\n    const byId = session && session.id !== undefined\n      ? sessionAttachmentsById.get(String(session.id))\n      : undefined\n    if (byId !== undefined) {\n      const hit = byId.get(String(id))\n      if (hit !== undefined) return hit\n    }\n    const map = session ? sessionAttachments.get(session) : undefined\n    const hit = map ? map.get(String(id)) : undefined\n    if (hit !== undefined) return hit\n    // Miss: fall back to the session event log. Ids announced by the harness\n    // for images it persisted itself (read_image re-uploads) live there even\n    // though they never crossed the inbox-claim stream, so this resolves them\n    // exactly like user-uploaded ids (issue #72). Refs from the log carry\n    // full metadata, so a later attachments.readImage(ref) verifies and\n    // returns the bytes.\n    if (session !== undefined) {\n      scanSessionEventLog(session)\n      const afterById = session.id !== undefined\n        ? sessionAttachmentsById.get(String(session.id))\n        : undefined\n      if (afterById !== undefined) {\n        const after = afterById.get(String(id))\n        if (after !== undefined) return after\n      }\n      const afterMap = sessionAttachments.get(session)\n      const afterHit = afterMap ? afterMap.get(String(id)) : undefined\n      if (afterHit !== undefined) return afterHit\n    }\n    return undefined\n  }`,
    `  const lookupAttachment = (session, id) => {\n    let hit = visionState.lookupAttachment(session, id)\n    if (hit !== undefined) return hit\n    // Cache eviction is a performance event, never a correctness event: the\n    // durable session log remains authoritative and can repopulate the ref.\n    if (session !== undefined) {\n      scanSessionEventLog(session)\n      hit = visionState.lookupAttachment(session, id)\n      if (hit !== undefined) return hit\n    }\n    return undefined\n  }`,
  )
}

function governorPhase() {
  insertAfter(
    'resource governor imports',
    "import { assertNoRepetitionLoop } from './lib/repetition-guard.js'\n",
    `import {\n  boundedOcrTiles,\n  defaultImageResourceGovernor,\n  estimateImageOperationBytes,\n  scaleBox,\n  scaledDimensions,\n} from './lib/image-resource-governor.js'\n`,
  )
  replaceOnce(
    'downscale fail closed',
    `/** Downscale bytes whose intrinsic pixel count exceeds maxPixels; returns original bytes on failure. */\nexport async function downscaleImage(bytes, maxPixels) {\n  try {\n    const sharp = await loadSharp()\n    const image = sharp(bytes, { failOn: 'none' })\n    const meta = await image.metadata()\n    if (!meta.width || !meta.height) return bytes\n    if (meta.width * meta.height <= maxPixels) return bytes\n    const scale = Math.sqrt(maxPixels / (meta.width * meta.height))\n    const width = Math.max(1, Math.round(meta.width * scale))\n    const height = Math.max(1, Math.round(meta.height * scale))\n    const resized = await image.resize({ width, height, fit: 'inside' }).toBuffer()\n    return resized.length > 0 && resized.length < bytes.length ? resized : bytes\n  } catch {\n    return bytes\n  }\n}`,
    `/**\n * Bound an image to a semantic-processing pixel budget. Metadata probing is\n * fail-open only until we know the source is oversized. Once oversize is\n * proven, preprocessing becomes a safety boundary and MUST fail closed.\n */\nexport async function downscaleImage(bytes, maxPixels, options = {}) {\n  let sharp\n  let meta\n  try {\n    sharp = await loadSharp()\n    meta = await sharp(bytes, { failOn: 'none' }).metadata()\n  } catch {\n    return bytes\n  }\n  if (!meta.width || !meta.height) return bytes\n  if (meta.width * meta.height <= maxPixels) return bytes\n  const target = scaledDimensions(meta.width, meta.height, maxPixels)\n  try {\n    return await defaultImageResourceGovernor.withBudget(\n      estimateImageOperationBytes('preview', meta.width, meta.height),\n      { signal: options.signal },\n      async () => {\n        const resized = await sharp(bytes, { failOn: 'none' })\n          .resize({ width: target.width, height: target.height, fit: 'inside' })\n          .toBuffer()\n        if (!resized || resized.length === 0) {\n          throw new Error('image resize produced an empty buffer')\n        }\n        // Pixel count, not compressed byte count, is the execution invariant.\n        // A safe preview may legitimately encode to more bytes than its source.\n        return resized\n      },\n    )\n  } catch (cause) {\n    const error = new Error(\n      'VISION_IMAGE_PREPROCESS_FAILED: oversized image could not be reduced to the safe execution budget',\n    )\n    error.code = 'VISION_IMAGE_PREPROCESS_FAILED'\n    error.cause = cause\n    throw error\n  }\n}`,
  )
  replaceOnce(
    'annotate one box',
    `export async function annotateBoxBuffer(bytes, box) {\n  const sharp = await loadSharp()\n  const image = sharp(bytes, { failOn: 'none' })\n  const meta = await image.metadata()\n  const width = meta.width ?? box.x2\n  const height = meta.height ?? box.y2\n  return image.composite([{ input: boxToSvg(box, width, height), top: 0, left: 0 }]).png().toBuffer()\n}`,
    `export async function annotateBoxBuffer(bytes, box) {\n  const sharp = await loadSharp()\n  const meta = await sharp(bytes, { failOn: 'none' }).metadata()\n  const width = meta.width ?? box.x2\n  const height = meta.height ?? box.y2\n  const preview = scaledDimensions(width, height, 4_000_000)\n  const displayBox = preview.scale === 1\n    ? box\n    : scaleBox(box, width, height, preview.width, preview.height)\n  return defaultImageResourceGovernor.withBudget(\n    estimateImageOperationBytes('annotation', width, height),\n    {},\n    async () => {\n      let image = sharp(bytes, { failOn: 'none' })\n      if (preview.scale !== 1) image = image.resize(preview.width, preview.height, { fit: 'fill' })\n      return image\n        .composite([{ input: boxToSvg(displayBox, preview.width, preview.height), top: 0, left: 0 }])\n        .png()\n        .toBuffer()\n    },\n  )\n}`,
  )
  replaceOnce(
    'annotate boxes',
    `export async function annotateBoxesBuffer(bytes, boxes) {\n  const sharp = await loadSharp()\n  const image = sharp(bytes, { failOn: 'none' })\n  const meta = await image.metadata()\n  const width = meta.width ?? 0\n  const height = meta.height ?? 0\n  if (width <= 0 || height <= 0 || boxes.length === 0) return bytes\n  return image.composite([{ input: boxesToSvg(boxes, width, height), top: 0, left: 0 }]).png().toBuffer()\n}`,
    `export async function annotateBoxesBuffer(bytes, boxes) {\n  const sharp = await loadSharp()\n  const meta = await sharp(bytes, { failOn: 'none' }).metadata()\n  const width = meta.width ?? 0\n  const height = meta.height ?? 0\n  if (width <= 0 || height <= 0 || boxes.length === 0) return bytes\n  const preview = scaledDimensions(width, height, 4_000_000)\n  const displayBoxes = preview.scale === 1\n    ? boxes\n    : boxes.map((box) => scaleBox(box, width, height, preview.width, preview.height))\n  return defaultImageResourceGovernor.withBudget(\n    estimateImageOperationBytes('annotation', width, height),\n    {},\n    async () => {\n      let image = sharp(bytes, { failOn: 'none' })\n      if (preview.scale !== 1) image = image.resize(preview.width, preview.height, { fit: 'fill' })\n      return image\n        .composite([{ input: boxesToSvg(displayBoxes, preview.width, preview.height), top: 0, left: 0 }])\n        .png()\n        .toBuffer()\n    },\n  )\n}`,
  )
  replaceOnce(
    'trace hard cap',
    `        let traceBytes = bytes\n        if (downscaleEnabled() && bytes && bytes.length > 0) {\n          traceBytes = await downscaleImage(bytes, Math.min(downscaleMaxPixels(), 1000000))\n        }`,
    `        let traceBytes = bytes\n        if (bytes && bytes.length > 0) {\n          const traceMaxPixels = Math.min(downscaleEnabled() ? downscaleMaxPixels() : 1_000_000, 1_000_000)\n          traceBytes = await downscaleImage(bytes, traceMaxPixels)\n        }`,
  )
  replaceOnce(
    'foreground hard cap',
    `        let fgBytes = bytes\n        if (downscaleEnabled() && bytes && bytes.length > 0) {\n          fgBytes = await downscaleImage(bytes, downscaleMaxPixels())\n        }`,
    `        let fgBytes = bytes\n        if (bytes && bytes.length > 0) {\n          const foregroundMaxPixels = Math.min(downscaleEnabled() ? downscaleMaxPixels() : 4_000_000, 4_000_000)\n          fgBytes = await downscaleImage(bytes, foregroundMaxPixels)\n        }`,
  )
}

function pixelPhase() {
  insertAfter(
    'pixel stream import',
    "import { assertNoRepetitionLoop } from './lib/repetition-guard.js'\n",
    "import { compareRgbaStreams } from './lib/pixel-diff-stream.js'\n",
  )
  replaceOnce(
    'pixel diff execute body',
    `        const originalRaw = await sharp(originalBytes, { failOn: 'none' })\n          .ensureAlpha()\n          .raw()\n          .toBuffer({ resolveWithObject: true })\n        const rebuiltRaw = await sharp(rebuiltBytes, { failOn: 'none' })\n          .resize(width, height, { fit: 'fill' })\n          .ensureAlpha()\n          .raw()\n          .toBuffer({ resolveWithObject: true })\n        const diff = computePixelDiff(originalRaw.data, rebuiltRaw.data, threshold, width, height)\n        const heatmap = renderDiffHeatmap(originalRaw.data, diff.mask, width, height)\n        const heatmapPng = await sharp(heatmap, { raw: { width, height, channels: 4 } })\n          .png()\n          .toBuffer()`,
    `        const pixels = width * height\n        let diff\n        let heatmapPng\n        let heatmapPreview = false\n        let heatmapWidth = width\n        let heatmapHeight = height\n        if (pixels <= 4_000_000) {\n          const release = await defaultImageResourceGovernor.acquire(\n            estimateImageOperationBytes('pixel-diff', width, height),\n          )\n          try {\n            const originalRaw = await sharp(originalBytes, { failOn: 'none' })\n              .ensureAlpha()\n              .raw()\n              .toBuffer({ resolveWithObject: true })\n            const rebuiltRaw = await sharp(rebuiltBytes, { failOn: 'none' })\n              .resize(width, height, { fit: 'fill' })\n              .ensureAlpha()\n              .raw()\n              .toBuffer({ resolveWithObject: true })\n            diff = computePixelDiff(originalRaw.data, rebuiltRaw.data, threshold, width, height)\n            const heatmap = renderDiffHeatmap(originalRaw.data, diff.mask, width, height)\n            heatmapPng = await sharp(heatmap, { raw: { width, height, channels: 4 } })\n              .png()\n              .toBuffer()\n          } finally {\n            release()\n          }\n        } else {\n          // Exact large-image metrics are accumulated from streaming RGBA\n          // output. No complete original/rebuilt framebuffer or full-size mask\n          // is retained in JavaScript memory.\n          const release = await defaultImageResourceGovernor.acquire(\n            estimateImageOperationBytes('pixel-diff', width, height),\n            { exclusive: true },\n          )\n          try {\n            const originalStream = sharp(originalBytes, { failOn: 'none' }).ensureAlpha().raw()\n            const rebuiltStream = sharp(rebuiltBytes, { failOn: 'none' })\n              .resize(width, height, { fit: 'fill' })\n              .ensureAlpha()\n              .raw()\n            diff = await compareRgbaStreams(originalStream, rebuiltStream, { width, height, threshold })\n          } finally {\n            release()\n          }\n\n          // The report stays exact, while the visual heatmap is intentionally\n          // bounded. Build it from a <=4MP representation instead of allocating\n          // another 100MP RGBA heatmap just for display.\n          const preview = scaledDimensions(width, height, 4_000_000)\n          heatmapWidth = preview.width\n          heatmapHeight = preview.height\n          heatmapPreview = true\n          const releasePreview = await defaultImageResourceGovernor.acquire(\n            estimateImageOperationBytes('preview', width, height),\n            { exclusive: true },\n          )\n          try {\n            const originalPreview = await sharp(originalBytes, { failOn: 'none' })\n              .resize(preview.width, preview.height, { fit: 'fill' })\n              .ensureAlpha()\n              .raw()\n              .toBuffer({ resolveWithObject: true })\n            const rebuiltPreview = await sharp(rebuiltBytes, { failOn: 'none' })\n              .resize(preview.width, preview.height, { fit: 'fill' })\n              .ensureAlpha()\n              .raw()\n              .toBuffer({ resolveWithObject: true })\n            const previewDiff = computePixelDiff(\n              originalPreview.data,\n              rebuiltPreview.data,\n              threshold,\n              preview.width,\n              preview.height,\n            )\n            const heatmap = renderDiffHeatmap(\n              originalPreview.data,\n              previewDiff.mask,\n              preview.width,\n              preview.height,\n            )\n            heatmapPng = await sharp(heatmap, {\n              raw: { width: preview.width, height: preview.height, channels: 4 },\n            }).png().toBuffer()\n          } finally {\n            releasePreview()\n          }\n        }`,
  )
  replaceOnce(
    'pixel report preview metadata',
    `          worstRegions: worst,\n        }`,
    `          worstRegions: worst,\n          ...(heatmapPreview ? { heatmapPreview: true, heatmapWidth, heatmapHeight } : {}),\n        }`,
  )
}

function tilesPhase() {
  replaceOnce(
    'long ocr windows',
    `        // Overlapping horizontal windows in reading order.\n        const windows = longOcrWindows(height, chunkHeight, overlap)`,
    `        // Cover the entire ORIGINAL image with bounded tiles. Ordinary\n        // long screenshots remain one full-width strip per row; ultra-wide\n        // images split horizontally instead of allocating an oversized strip.\n        const windows = boundedOcrTiles(width, height, {\n          chunkHeight,\n          overlap,\n          maxTilePixels: 4_000_000,\n        })`,
  )
  replaceOnce(
    'long ocr skipped tile coordinates',
    `              top: windows[i].top,\n              bottom: windows[i].bottom,`,
    `              left: windows[i].left,\n              right: windows[i].right,\n              top: windows[i].top,\n              bottom: windows[i].bottom,`,
  )
  replaceOnce(
    'long ocr extract tile',
    `          const { top, bottom } = windows[i]\n          const chunk = await sharp(bytes, { failOn: 'none' })\n            .extract({ left: 0, top, width, height: bottom - top })\n            .png()\n            .toBuffer()`,
    `          const { left, right, top, bottom } = windows[i]\n          const tileWidth = right - left\n          const tileHeight = bottom - top\n          const releaseTile = await defaultImageResourceGovernor.acquire(\n            estimateImageOperationBytes('tile', tileWidth, tileHeight),\n          )\n          let chunk\n          try {\n            chunk = await sharp(bytes, { failOn: 'none' })\n              .extract({ left, top, width: tileWidth, height: tileHeight })\n              .png()\n              .toBuffer()\n          } finally {\n            releaseTile()\n          }`,
  )
  replaceOnce(
    'long ocr result coordinates',
    `          results.push({ chunk: i + 1, top, bottom, engine: used, chars: text.length, text })`,
    `          results.push({ chunk: i + 1, left, right, top, bottom, engine: used, chars: text.length, text })`,
  )
}

switch (phase) {
  case 'session':
    statePhase()
    break
  case 'governor':
    governorPhase()
    break
  case 'pixel':
    pixelPhase()
    break
  case 'tiles':
    tilesPhase()
    break
  default:
    throw new Error(`unknown phase: ${phase}`)
}

await writeFile(file, source)
console.log(`issue 208 patch phase applied: ${phase}`)
