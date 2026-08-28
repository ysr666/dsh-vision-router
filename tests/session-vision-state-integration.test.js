import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
const indexSource = await readFile(new URL('../lib/session-vision-index.js', import.meta.url), 'utf8')

test('runtime no longer owns cross-turn vision state in process-global raw Maps', () => {
  assert.match(source, /const sessionVisionRuntime = runtime\?\.sessionVision/)
  assert.match(
    source,
    /const visionState = sessionVisionRuntime\?\.stateStore \?\? createSessionVisionStateStore\(/,
    'explicit composition ownership must take precedence while preserving two-argument direct-call fallback',
  )
  assert.match(
    source,
    /const visionIndex = sessionVisionRuntime\?\.index \?\? createSessionVisionIndex\(/,
    'direct core fallback must reuse the same centralized SessionVisionIndex implementation',
  )
  assert.doesNotMatch(source, /const imageMemory = new Map\(\)/)
  assert.doesNotMatch(source, /const sessionAttachmentsById = new Map\(\)/)
  assert.doesNotMatch(source, /const scannedSessionEventSeqs = new Map\(\)/)
})

test('session-visible paths use the bound memory view instead of the global compatibility facade', () => {
  assert.match(source, /const sessionImageMemory = visionState\.memoryForSession\(session\)/)
  assert.match(source, /memory: sessionImageMemory/)
  assert.match(source, /rewriteHistoryImages\(messages, sessionImageMemory\)/)
  assert.match(source, /rewriteHistoryImages\(base, sessionImageMemory\)/)
  assert.match(source, /const scopedMemory = session \? visionState\.memoryForSession\(session\) : imageMemory/)
  assert.match(source, /for \(const id of ids\) scopedMemory\.set\(id, memory\)/)
})

test('attachment cache miss performs target-only durable log recovery in SessionVisionIndex only', () => {
  assert.match(indexSource, /core\.collectEventAttachmentRefs\(events\)\.find\(/)
  assert.match(indexSource, /String\(ref\.attachmentId \?\? ref\.id\) === wanted/)
  assert.match(indexSource, /store\.recordAttachments\(session, \[recovered\]\)/)
  assert.doesNotMatch(source, /collectEventAttachmentRefs\(events\)\.find\(/)
})

test('high-resolution upload admission remains separate from execution budgets', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /maxImageBytes:\s*20971520/)
  assert.match(patch, /maxImagePixels:\s*100000000/)
  assert.match(source, /boundedOcrTiles\(width, height/)
  assert.match(source, /maxTilePixels:\s*4_000_000/)
  assert.match(source, /if \(pixels <= 4_000_000\)/)
  assert.match(source, /compareRgbaStreams\(originalStream, rebuiltStream/)
})

test('large crop is a bounded preview with an explicit original-coordinate refinement path', () => {
  assert.match(source, /const sourceWidth = box\.x2 - box\.x1/)
  assert.match(source, /scaledDimensions\(sourceWidth, sourceHeight, 4_000_000\)/)
  assert.match(source, /estimateImageOperationBytes\('crop', sourceWidth, sourceHeight\)/)
  assert.match(source, /sourceRegion: box/)
  assert.match(source, /Use vision_crop again with a smaller ORIGINAL-pixel region for tiny details/)
})

test('vision_present passes admitted compressed image bytes through instead of forced PNG re-encoding', () => {
  assert.match(source, /const \{ bytes, mediaType \} = await readImageBytes\(exec, args\.image\)/)
  assert.match(source, /data: bytes,\s*mediaType,/s)
  assert.doesNotMatch(source, /const png = await sharp\(bytes, \{ failOn: 'none' \}\)\.png\(\)\.toBuffer\(\)/)
})
