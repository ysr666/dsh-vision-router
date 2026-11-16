import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { encodeNativeOcrRgbFrame, runIsolatedLocalOcr } from '../src/lib/native-ocr-supervisor.js'

const valid = 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({text:"吃饱了",confidence:0.98})))'
const args = (program, options = {}) => ({
  executable: process.execPath,
  args: ['-e', program],
  timeoutMs: 1500,
  ...options,
})
const input = Buffer.from('isolated test image')

test('native OCR supervisor preserves UTF-8, validates confidence, sets engine identity', async () => {
  const result = await runIsolatedLocalOcr(input, args(valid))
  assert.deepEqual(result, { text: '吃饱了', confidence: 0.98, engine: 'ncnn' })
})

test('native OCR supervisor rejects untrusted paths, invalid input and arguments', async () => {
  await assert.rejects(runIsolatedLocalOcr(input, { executable: 'relative/program' }), { code: 'OCR_UNTRUSTED_RUNNER' })
  await assert.rejects(runIsolatedLocalOcr(Buffer.alloc(0), args(valid)), { code: 'OCR_INVALID_INPUT' })
  await assert.rejects(runIsolatedLocalOcr(Buffer.alloc(24 * 1024 * 1024 + 1), args(valid)), { code: 'OCR_INVALID_INPUT' })
  await assert.rejects(runIsolatedLocalOcr(input, args(valid, { args: [1] })), { code: 'OCR_INVALID_ARGUMENTS' })
  await assert.rejects(runIsolatedLocalOcr(input, args(valid, { timeoutMs: 0 })), { code: 'OCR_INVALID_TIMEOUT' })
})

test('native OCR supervisor rejects broken native exit and missing executable without raw stderr leakage', async () => {
  await assert.rejects(runIsolatedLocalOcr(input, args('process.stderr.write("SECRET_TOKEN"); process.exit(17)')), {
    code: 'OCR_WORKER_FAILED',
  })
  const missing = process.platform === 'win32'
    ? 'C:\\missing-ocr-worker-abcdef.exe'
    : '/tmp/missing-ocr-worker-abcdef'
  await assert.rejects(runIsolatedLocalOcr(input, { executable: missing }), { code: 'OCR_SPAWN_FAILED' })
})

test('native OCR supervisor terminates hung worker within the bounded timeout', async () => {
  const start = performance.now()
  await assert.rejects(
    runIsolatedLocalOcr(input, args('process.stdin.resume();setInterval(()=>{},1000)', { timeoutMs: 120 })),
    { code: 'OCR_TIMEOUT' },
  )
  assert.ok(performance.now() - start < 1600)
})

test('native OCR supervisor abort is terminal and cleans up the worker', async () => {
  const ctl = new AbortController()
  const task = runIsolatedLocalOcr(input, args('process.stdin.resume();setInterval(()=>{},1000)', { timeoutMs: 2500, signal: ctl.signal }))
  setTimeout(() => ctl.abort(), 60)
  await assert.rejects(task, { code: 'OCR_CANCELLED' })
  await assert.rejects(runIsolatedLocalOcr(input, args(valid, { signal: ctl.signal })), { code: 'OCR_CANCELLED' })
})

test('native OCR supervisor rejects unbounded output and malformed JSON/results', async () => {
  await assert.rejects(
    runIsolatedLocalOcr(input, args('process.stdout.write("x".repeat(8000))', { maxOutputBytes: 1000 })),
    { code: 'OCR_OUTPUT_LIMIT' },
  )
  await assert.rejects(runIsolatedLocalOcr(input, args('process.stdout.write("{broken")')), { code: 'OCR_INVALID_RESULT' })
  await assert.rejects(runIsolatedLocalOcr(input, args('process.stdout.write(JSON.stringify({ text: 13 }))')), { code: 'OCR_INVALID_RESULT' })
  await assert.rejects(runIsolatedLocalOcr(input, args('process.stdout.write(JSON.stringify({ text: "ok", confidence: 12 }))')), { code: 'OCR_INVALID_RESULT' })
})

test('native OCR supervisor does not pass credentials to workers', async () => {
  const old = process.env.OCR_TEST_SECRET
  process.env.OCR_TEST_SECRET = 'never-send-this-secret'
  try {
    const result = await runIsolatedLocalOcr(input, args('process.stdout.write(JSON.stringify({text:String(process.env.OCR_TEST_SECRET)}))'))
    assert.equal(result.text, 'undefined')
  } finally {
    if (old === undefined) delete process.env.OCR_TEST_SECRET
    else process.env.OCR_TEST_SECRET = old
  }
})

test('native OCR worker receives only the Linux parent identity, not inherited host secrets', async () => {
  const old = process.env.DVR_OCR_PARENT_PID
  const secret = process.env.OCR_TEST_SECRET
  process.env.DVR_OCR_PARENT_PID = 'untrusted-forged-value'
  process.env.OCR_TEST_SECRET = 'never-send-this-secret'
  try {
    const worker = 'process.stdout.write(JSON.stringify({text:JSON.stringify({parent:process.env.DVR_OCR_PARENT_PID??null,secret:process.env.OCR_TEST_SECRET??null})}))'
    const result = await runIsolatedLocalOcr(input, args(worker))
    const seen = JSON.parse(result.text)
    assert.equal(seen.parent, process.platform === 'linux' ? String(process.pid) : null)
    assert.equal(seen.secret, null)
  } finally {
    if (old === undefined) delete process.env.DVR_OCR_PARENT_PID
    else process.env.DVR_OCR_PARENT_PID = old
    if (secret === undefined) delete process.env.OCR_TEST_SECRET
    else process.env.OCR_TEST_SECRET = secret
  }
})

test('native OCR supervisor supports concurrent isolated jobs without mixing outputs', async () => {
  const jobs = Array.from({ length: 12 }, (_, i) => {
    const bytes = Buffer.from('OCR-' + i)
    return runIsolatedLocalOcr(bytes, args(
      'let s=""; process.stdin.on("data",v=>s+=v); process.stdin.on("end",()=>process.stdout.write(JSON.stringify({text:s})))',
      { timeoutMs: 3000 },
    ))
  })
  const result = await Promise.all(jobs)
  assert.deepEqual(result.map((v) => v.text), Array.from({ length: 12 }, (_, i) => 'OCR-' + i))
})

test('RGB24 frame encoding bounds dimensions and preserves exact pixel order', () => {
  const rgb = Uint8Array.from([255, 0, 10, 0, 25, 200])
  const frame = encodeNativeOcrRgbFrame(rgb, 2, 1)
  assert.equal(frame.toString('ascii', 0, 8), 'DVR3OCR1')
  assert.equal(frame.readUInt32LE(8), 2)
  assert.equal(frame.readUInt32LE(12), 1)
  assert.equal(frame.readUInt32LE(16), 6)
  assert.deepEqual(Array.from(frame.subarray(20)), Array.from(rgb))
  assert.throws(() => encodeNativeOcrRgbFrame(rgb, 0, 1), { code: 'OCR_INVALID_DIMENSIONS' })
  assert.throws(() => encodeNativeOcrRgbFrame(rgb, 4096, 4096), { code: 'OCR_INVALID_DIMENSIONS' })
  assert.throws(() => encodeNativeOcrRgbFrame(rgb, 3, 1), { code: 'OCR_INVALID_RGB' })
  assert.throws(() => encodeNativeOcrRgbFrame(null, 2, 1), { code: 'OCR_INVALID_RGB' })
})

test('native OCR supervisor caps workers and returns busy without launching an unlimited queue', async () => {
  const slow = 'process.stdin.resume(); process.stdin.on("end", () => { setTimeout(() => process.stdout.write(JSON.stringify({text:"safe"})), 160) })'
  const jobs = Array.from({ length: 23 }, () => runIsolatedLocalOcr(input, args(slow, { timeoutMs: 3500 })))
  const settled = await Promise.allSettled(jobs)
  const busy = settled.filter((x) => x.status === 'rejected' && x.reason?.code === 'OCR_BUSY')
  const successful = settled.filter((x) => x.status === 'fulfilled' && x.value.text === 'safe')
  assert.ok(busy.length >= 3, 'bounded queue must reject excess requests')
  assert.ok(successful.length > 0)
  assert.equal(successful.length + busy.length, jobs.length)
})

test('cancelled queued OCR task never starts after active jobs finish', async () => {
  const slow = 'process.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>process.stdout.write(JSON.stringify({text:"done"})),220))'
  const tasks = [
    runIsolatedLocalOcr(input, args(slow, { timeoutMs: 1500 })),
    runIsolatedLocalOcr(input, args(slow, { timeoutMs: 1500 })),
  ]
  const abort = new AbortController()
  let invoked = false
  const queued = runIsolatedLocalOcr(input, args(
    'process.stdout.write(JSON.stringify({text:"must not start"}))',
    { timeoutMs: 1500, signal: abort.signal },
  )).then(() => { invoked = true })
  abort.abort()
  await assert.rejects(queued, { code: 'OCR_CANCELLED' })
  await Promise.all(tasks)
  assert.equal(invoked, false)
})
