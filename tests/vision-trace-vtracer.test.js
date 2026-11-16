import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import {
  posterizeSvg, posterizeSvgColor, quantizeColors,
} from '../lib/core-primitives.js'
import { runIsolatedTraceProcess } from '../lib/trace-vtracer-process-runtime.js'

function colorSample() {
  const width = 64, height = 48
  const rgba = Buffer.alloc(width * height * 4, 255)
  for (let y = 10; y < 30; y++) for (let x = 20; x < 40; x++) {
    const i = (y * width + x) * 4
    rgba[i] = 220; rgba[i + 1] = 30; rgba[i + 2] = 30
  }
  return { rgba, info: { width, height } }
}

test('VTracer color output uses supplied palette, stable SVG and white holes', async () => {
  const { rgba, info } = colorSample()
  const palette = quantizeColors(rgba, 2)
  const outputs = await Promise.all(Array.from({ length: 4 }, () =>
    posterizeSvgColor(rgba, info, palette, 10000)))
  assert.equal(new Set(outputs).size, 1, 'parallel calls should be deterministic')
  assert.match(outputs[0], /<svg[\s>]/)
  assert.match(outputs[0], /<path\b/)
  console.log('TRACE_PALETTE', JSON.stringify(palette), 'SVG', outputs[0].slice(0, 500))
  const raster = await sharp(Buffer.from(outputs[0])).resize(info.width, info.height)
    .flatten({ background: '#ffffff' }).raw().toBuffer()
  const center = (20 * info.width + 30) * 3
  assert.ok(raster[center] > raster[center + 1], 'red region must be visibly red')
})

test('VTracer grayscale respects 1 and 4 posterization levels', async () => {
  const input = await sharp({
    create: { width: 128, height: 96, channels: 4, background: '#ffffff' },
  }).composite([{
    input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="96"><rect x="10" y="5" width="36" height="86" fill="#1a1a1a"/><rect x="49" y="5" width="38" height="86" fill="#777777"/><rect x="90" y="5" width="28" height="86" fill="#d0d0d0"/></svg>'),
  }]).png().toBuffer()
  const a = await posterizeSvg(input, 1, 'dominant', 8000)
  const b = await posterizeSvg(input, 4, 'dominant', 8000)
  assert.match(a, /<svg[\s>]/)
  assert.match(b, /<svg[\s>]/)
  assert.notEqual(a, b, 'steps must affect the output')
})

test('invalid color buffers and non-palettes are rejected', async () => {
  await assert.rejects(posterizeSvgColor(Buffer.alloc(4), { width: 64, height: 64 }, [{ hex: '#ffffff' }]), /RGBA/)
  await assert.rejects(posterizeSvgColor(Buffer.alloc(4), { width: 1, height: 1 }, [{ hex: 'javascript:foo' }]), /palette/)
})

test('AbortSignal cancels Worker and zero deadline is fail closed', async () => {
  const { rgba, info } = colorSample()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(posterizeSvgColor(rgba, info, [{ hex: '#ffffff' }], 10000, { signal: controller.signal }), /abort/i)
  await assert.rejects(posterizeSvgColor(rgba, info, [{ hex: '#ffffff' }], 0), /timed out/)
})

test('VTracer executes off-main-thread', async () => {
  const png = await sharp({ create: { width: 128, height: 128, channels: 4, background: '#ffffff' } }).png().toBuffer()
  const vectorizing = posterizeSvg(png, 4, 'dominant', 8000)
  const winner = await Promise.race([
    vectorizing.then(() => 'worker-done'),
    delay(0).then(() => 'main-timer'),
  ])
  assert.equal(winner, 'main-timer')
  await vectorizing
})


test('successive mixed VTracer workers complete and cleanly exit without leaking native state', async () => {
  const { rgba, info } = colorSample()
  const png = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()
  for (let i = 0; i < 4; i++) {
    const [color, gray] = await Promise.all([
      posterizeSvgColor(rgba, info, 3, 10000),
      posterizeSvg(png, 4, 'dominant', 10000),
    ])
    assert.match(color, /<svg[\s>]/)
    assert.match(gray, /<svg[\s>]/)
  }
})

test('isolated VTracer child must not publish a message from an abnormal process exit', async () => {
  const childUrl = new URL('./fixtures/trace-process-fault.mjs', import.meta.url)
  for (const mode of ['premature-success', 'exit-without-message']) {
    await assert.rejects(runIsolatedTraceProcess({
      mode, payload: {}, timeoutMs: 15000, childUrl,
    }), /process exited before producing SVG/)
  }
  // The parent Node process remains usable after both child faults.
  const { rgba, info } = colorSample()
  assert.match(await posterizeSvgColor(rgba, info, 2, 10000), /<svg[\s>]/)
})

test('isolated trace IPC rejects clean-exit invalid SVG and permits valid markup', async () => {
  const childUrl = new URL('./fixtures/trace-process-fault.mjs', import.meta.url)
  await assert.rejects(runIsolatedTraceProcess({
    mode: 'invalid-svg', payload: {}, timeoutMs: 10000, childUrl,
  }), /invalid result/)
  const svg = await runIsolatedTraceProcess({
    mode: 'valid-svg', payload: {}, timeoutMs: 10000, childUrl,
  })
  assert.match(svg, /<svg[\s>]/)
})

test('isolated VTracer child timeout and cancellation kill stalled work', async () => {
  const childUrl = new URL('./fixtures/trace-process-fault.mjs', import.meta.url)
  await assert.rejects(runIsolatedTraceProcess({
    mode: 'hang', payload: {}, timeoutMs: 75, childUrl,
  }), /timed out/)

  const controller = new AbortController()
  const pending = runIsolatedTraceProcess({
    mode: 'hang', payload: {}, timeoutMs: 10000,
    signal: controller.signal,
    abortReason: () => new Error('probe canceled'),
    childUrl,
  })
  await delay(50)
  controller.abort()
  await assert.rejects(pending, /probe canceled/)
})

test('isolated VTracer process queue is bounded and recovers after all deadlines', async () => {
  const childUrl = new URL('./fixtures/trace-process-fault.mjs', import.meta.url)
  const requests = Array.from({ length: 12 }, () => runIsolatedTraceProcess({
    mode: 'hang', payload: {}, timeoutMs: 450, childUrl,
  }))
  const settled = await Promise.allSettled(requests)
  assert.equal(settled.filter((entry) => entry.status === 'rejected').length, 12)
  assert.ok(settled.some((entry) =>
    String(entry.reason?.message).includes('capacity exceeded')),
  'excess work must be refused rather than spawning unlimited children')

  const { rgba, info } = colorSample()
  const result = await posterizeSvgColor(rgba, info, 2, 10000)
  assert.ok(result.includes('<svg'), 'a later healthy trace must not be stuck in the queue')
})

test('VTracer honors explicit palette values, not just palette length', async () => {
  const { rgba, info } = colorSample()
  const redAndWhite = [{ hex: '#ff0000' }, { hex: '#ffffff' }]
  const greenAndBlue = [{ hex: '#00ff00' }, { hex: '#0000ff' }]
  const a = await posterizeSvgColor(rgba, info, redAndWhite, 8000)
  const b = await posterizeSvgColor(rgba, info, greenAndBlue, 8000)
  assert.notEqual(a, b, 'distinct palettes of equal size must produce distinct SVGs')
  const used = (svg) => [...svg.matchAll(/<path\b[^>]*\bfill="(#[0-9a-f]{6})"/g)]
    .map((m) => m[1])
  assert.ok(used(a).length > 0)
  assert.ok(used(b).length > 0)
  assert.ok(used(a).every((c) => redAndWhite.some((p) => p.hex === c)))
  assert.ok(used(b).every((c) => greenAndBlue.some((p) => p.hex === c)))
})

test('Auto-color mode preserves quality and respects the 1..16 budget, including transparency', async () => {
  const { rgba, info } = colorSample()
  for (let i = 0; i < rgba.length; i += 4 * info.width) rgba[i + 3] = 0
  for (const maxColors of [1, 2, 8, 16]) {
    const svg = await posterizeSvgColor(rgba, info, maxColors, 8000)
    const colors = new Set([...svg.matchAll(/<path\b[^>]*\bfill="(#[0-9a-f]{6})"/g)]
      .map((m) => m[1]))
    assert.ok(colors.size <= maxColors, `requested ${maxColors}, got ${colors.size}`)
  }
  await assert.rejects(posterizeSvgColor(rgba, info, 17), /color limit|palette/)
  await assert.rejects(posterizeSvgColor(rgba, info, 0), /color limit|palette/)
})

test('Host Node --input-type=module entry does not propagate incompatible flags to file worker', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('../', import.meta.url))
  const program = `import {posterizeSvgColor} from './lib/core-primitives.js';
    const w=16,h=16,b=Buffer.alloc(w*h*4,255);
    const svg=await posterizeSvgColor(b,{width:w,height:h},2,8000);
    if (!svg.includes('<svg')) process.exit(2);
    console.log('WORKER_INPUT_TYPE_OK');`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: root, encoding: 'utf8', timeout: 14000, windowsHide: true,
  })
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  assert.match(child.stdout, /WORKER_INPUT_TYPE_OK/)
})


test('adaptive grayscale steps preserve a continuous gradient instead of collapsing to one fill', async () => {
  const width = 256, height = 64
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    rgba[i] = rgba[i + 1] = rgba[i + 2] = x
    rgba[i + 3] = 255
  }
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer()
  const results = []
  for (const steps of [1, 4, 8, 16]) {
    const svg = await posterizeSvg(png, steps, 'dominant', 10000)
    const fills = new Set([...svg.matchAll(/fill="(#[a-f0-9]{6})"/gi)].map((match) => match[1]))
    const actual = await sharp(Buffer.from(svg)).resize(width, height)
      .flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer()
    let sum = 0
    for (let i = 0; i < width * height; i++) sum += Math.abs(actual[i * 3] - (i % width))
    results.push({ steps, error: sum / (width * height), fills: fills.size })
  }
  assert.ok(results[1].fills >= 3, '4 gray steps must not collapse to one flat fill')
  assert.ok(results[3].fills >= 6, '16 gray steps must produce multiple distinct grayscale regions')
  assert.ok(results[3].error < 22, '16 gray steps must reconstruct the reference gradient')
  assert.ok(results[3].error < results[0].error, 'additional grayscale steps must improve gradient fidelity')
})
