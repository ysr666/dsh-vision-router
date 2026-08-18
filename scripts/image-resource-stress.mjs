import assert from 'node:assert/strict'
import sharp from 'sharp'
import { downscaleImage } from '../index.js'
import { defaultImageResourceGovernor } from '../lib/image-resource-governor.js'

const WIDTH = Number(process.env.STRESS_IMAGE_WIDTH || 10_000)
const HEIGHT = Number(process.env.STRESS_IMAGE_HEIGHT || 10_000)
const MAX_INPUT_BYTES = 20 * 1024 * 1024
const MAX_PIXELS = 100_000_000
const SAFE_PIXELS = 4_000_000
const MAX_DELTA_MIB = Number(process.env.STRESS_MAX_DELTA_MIB || 256)

if (!Number.isInteger(WIDTH) || !Number.isInteger(HEIGHT) || WIDTH <= 0 || HEIGHT <= 0) {
  throw new Error('STRESS_IMAGE_WIDTH/HEIGHT must be positive integers')
}
if (WIDTH * HEIGHT > MAX_PIXELS) {
  throw new Error(`stress fixture exceeds host admission: ${WIDTH}x${HEIGHT}`)
}

const input = await sharp({
  create: {
    width: WIDTH,
    height: HEIGHT,
    channels: 3,
    background: { r: 241, g: 244, b: 248 },
  },
})
  // A solid PNG is intentionally highly compressed: this exercises the case
  // where compressed byte size is tiny but decoded pixel work is near-limit.
  .png({ compressionLevel: 9 })
  .toBuffer()

assert.ok(input.length <= MAX_INPUT_BYTES, `compressed fixture is ${input.length} bytes (>20MB)`)
const sourceMeta = await sharp(input).metadata()
assert.equal(sourceMeta.width, WIDTH)
assert.equal(sourceMeta.height, HEIGHT)

async function run(concurrency) {
  if (typeof global.gc === 'function') {
    global.gc()
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  const baseline = process.memoryUsage().rss
  let peak = baseline
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, 10)
  sampler.unref?.()
  const startedAt = Date.now()
  let outputs
  try {
    outputs = await Promise.all(
      Array.from({ length: concurrency }, () => downscaleImage(input, SAFE_PIXELS)),
    )
    peak = Math.max(peak, process.memoryUsage().rss)
  } finally {
    clearInterval(sampler)
  }

  for (const output of outputs) {
    const meta = await sharp(output).metadata()
    assert.ok((meta.width ?? Infinity) * (meta.height ?? Infinity) <= SAFE_PIXELS)
  }
  const after = process.memoryUsage().rss
  const delta = Math.max(0, peak - baseline)
  const deltaMiB = delta / (1024 * 1024)
  const record = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    width: WIDTH,
    height: HEIGHT,
    sourcePixels: WIDTH * HEIGHT,
    compressedBytes: input.length,
    concurrency,
    baselineRssMiB: Number((baseline / (1024 * 1024)).toFixed(1)),
    peakRssMiB: Number((peak / (1024 * 1024)).toFixed(1)),
    peakDeltaMiB: Number(deltaMiB.toFixed(1)),
    afterRssMiB: Number((after / (1024 * 1024)).toFixed(1)),
    elapsedMs: Date.now() - startedAt,
    governor: defaultImageResourceGovernor.stats(),
  }
  console.log(JSON.stringify(record))
  assert.equal(record.governor.activeCount, 0, 'resource permits must be released')
  assert.equal(record.governor.queued, 0, 'resource queue must drain')
  assert.ok(
    deltaMiB <= MAX_DELTA_MIB,
    `RSS delta ${deltaMiB.toFixed(1)} MiB exceeded ${MAX_DELTA_MIB} MiB at concurrency ${concurrency}`,
  )
  outputs = undefined
  return record
}

const records = []
for (const concurrency of [1, 2, 4]) records.push(await run(concurrency))

console.log(
  JSON.stringify({
    ok: true,
    admission: { maxInputBytes: MAX_INPUT_BYTES, maxPixels: MAX_PIXELS },
    safePreviewPixels: SAFE_PIXELS,
    maxAllowedDeltaMiB: MAX_DELTA_MIB,
    records,
  }),
)
