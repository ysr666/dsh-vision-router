import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { ocrWithTesseractAdaptive, execFileWithStdin, shouldVerifyUncertainAutoOcr, verifyUncertainAutoOcrResult } from '../lib/core-primitives.js'
import { prepareTesseractSubtitleRetry } from '../lib/tesseract-image-preprocess.js'

const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'
function tsv(text, confidence) {
  return [header, `5\t1\t1\t1\t1\t1\t0\t0\t20\t10\t${confidence}\t${text}`].join('\n')
}
function stubRuns(entries, observed) {
  return async (_file, args, options) => {
    const psm = Number(args[args.indexOf('--psm') + 1])
    const stage = Buffer.from(options.input).toString() === 'prepared' ? 'prepared' : 'original'
    const item = entries[`${stage}-${psm}`] ?? { text: '', confidence: -1 }
    const isTsv = args.at(-1) === 'tsv'
    observed.push({ psm, stage, isTsv })
    return { stdout: isTsv ? tsv(item.text, item.confidence) : item.text }
  }
}

test('issue #836: weak original PSM 6 can be rescued by PSM 7 single-line layout', async () => {
  const observed = []
  const result = await ocrWithTesseractAdaptive(Buffer.from('original'), 12000, {
    exec: stubRuns({
      'original-6': { text: 'o咏饮了', confidence: 18 },
      'original-7': { text: '吃饱了', confidence: 94 },
      'original-3': { text: '乱码', confidence: 15 },
      'original-11': { text: '', confidence: -1 },
    }, observed),
  })
  assert.equal(result.text, '吃饱了')
  assert.equal(result.psm, 7)
  assert.equal(result.uncertain, false)
  assert.deepEqual(result.attemptedPsms, [6, 7, 3, 11])
  assert.ok(observed.some(x => x.psm === 7 && x.isTsv))
})

test('issue #836: weak white-on-dark candidate gets a local-only preprocessed PSM 7 retry', async () => {
  const observed = []
  let preparedCalls = 0
  const result = await ocrWithTesseractAdaptive(Buffer.from('original'), 12000, {
    exec: stubRuns({
      'original-6': { text: '本', confidence: 15 },
      'original-7': { text: '巡', confidence: 15 },
      'original-3': { text: '', confidence: -1 },
      'original-11': { text: '', confidence: -1 },
      'prepared-7': { text: '摆烂了', confidence: 97 },
    }, observed),
    preprocess: async (_bytes, context) => {
      assert.ok(context.remainingMs > 0)
      preparedCalls++
      return { bytes: Buffer.from('prepared'), variant: 'subtitle-inverted' }
    },
  })
  assert.equal(preparedCalls, 1)
  assert.equal(result.text, '摆烂了')
  assert.equal(result.variant, 'subtitle-inverted')
  assert.equal(result.uncertain, false)
  assert.deepEqual(result.attemptedPsms, [6, 7, 3, 11, 7])
  assert.equal(observed.filter(x => x.stage === 'prepared').length, 2)
})

test('issue #836: high-confidence normal text never incurs preprocessing', async () => {
  let prepareCalls = 0
  const result = await ocrWithTesseractAdaptive(Buffer.from('original'), 12000, {
    exec: stubRuns({
      'original-6': { text: '正常段落文字', confidence: 96 },
    }, []),
    preprocess: async () => { prepareCalls++; throw Error('should not preprocess') },
  })
  assert.equal(result.psm, 6)
  assert.equal(result.uncertain, false)
  assert.deepEqual(result.attemptedPsms, [6])
  assert.equal(prepareCalls, 0)
})

test('issue #836: preprocessing errors preserve the best local transcript', async () => {
  const original = { 'original-6': { text: '低置信度', confidence: 23 } }
  const result = await ocrWithTesseractAdaptive(Buffer.from('original'), 12000, {
    exec: stubRuns(original, []),
    preprocess: async () => { throw Error('sharp unavailable') },
  })
  assert.equal(result.text, '低置信度')
  assert.equal(result.uncertain, true)
})

test('issue #836: aborted preprocessing never starts another OCR worker', async () => {
  const controller = new AbortController()
  const reason = Error('cancelled by user')
  let calls = 0
  await assert.rejects(ocrWithTesseractAdaptive(Buffer.from('original'), 12000, {
    signal: controller.signal,
    exec: async (_file, args) => {
      calls++
      if (args.at(-1) === 'tsv') return { stdout: tsv('乱码', 15) }
      return { stdout: '乱码' }
    },
    preprocess: async () => { controller.abort(reason); throw reason },
  }), /cancelled by user/)
  assert.equal(calls, 8, '4 weak layout attempts with TSV, but no post-abort retry')
})

test('issue #836: dark subtitle crop is inverted, bright background is not', async () => {
  const create = async background => sharp({ create: {
    width: 300, height: 300, channels: 3, background,
  } }).png().toBuffer()
  const dark = await prepareTesseractSubtitleRetry(await create('#282828'), {
    loadSharp: async () => sharp, remainingMs: 8000,
  })
  assert.equal(dark.variant, 'subtitle-inverted')
  const light = await prepareTesseractSubtitleRetry(await create('#f4f4f4'), {
    loadSharp: async () => sharp, remainingMs: 8000,
  })
  assert.equal(light.variant, 'subtitle-grayscale')
  for (const result of [dark, light]) {
    assert.equal((await sharp(result.bytes).metadata()).width, 960)
    assert.ok(result.bytes.length > 100)
  }
  assert.equal(await prepareTesseractSubtitleRetry(await create('#282828'), {
    loadSharp: async () => { throw Error('unused') }, remainingMs: 100,
  }), null)
})


test('issue #836: actual asynchronous subprocess receives image bytes on stdin', async () => {
  const payload = Buffer.from('image-stdin-boundary-hello')
  const result = await execFileWithStdin(
    process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'],
    { input: payload, timeout: 3000, maxBuffer: 1024 },
  )
  assert.equal(result.stdout, payload.toString('utf8'))
  await assert.rejects(
    execFileWithStdin(process.execPath, ['-e', 'setTimeout(()=>{},5000)'],
      { input: new Uint8Array(), timeout: 70, maxBuffer: 1024 }),
    error => error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT',
  )
})

test('issue #836: only auto+uncertain+consented+unblocked+time-left uses vision fallback', () => {
  const baseline = {
    engine: 'auto', uncertain: true, localOnlyVision: false,
    degraded: false, remainingMs: 1500,
  }
  assert.equal(shouldVerifyUncertainAutoOcr(baseline), true)
  for (const override of [
    { engine: 'tesseract' }, { engine: 'vision' },
    { uncertain: false }, { localOnlyVision: true },
    { degraded: true }, { remainingMs: 1199 },
    { remainingMs: Number.NaN },
  ]) assert.equal(shouldVerifyUncertainAutoOcr({ ...baseline, ...override }), false)
})

test('issue #836: installed ncnn uncertain text can use permitted vision review without a Tesseract retry', async () => {
  const local = { engine: 'ncnn', text: 'C2H2(1)', uncertain: true,
    review: { numericOrFormulaRisks: [{ text: 'C2H2(1)' }] } }
  let calls = 0
  const result = await verifyUncertainAutoOcrResult(local, {
    engine: 'auto', remainingMs: 5000,
    verifyVision: async () => { calls++; return { text: 'C₂H₂(l)' } },
  })
  assert.equal(calls, 1)
  assert.equal(result.engine, 'vision')
  assert.equal(result.text, 'C₂H₂(l)')
  assert.equal(result.review.localEngine, 'ncnn')
  assert.equal(result.review.localText, 'C2H2(1)')
  assert.equal(result.review.fallbackReason, 'low_confidence_local_ocr')
})

test('issue #836: ncnn review respects local-only, breaker, deadline, and confidence', async () => {
  const local = { engine: 'ncnn', text: '局部可信文字', uncertain: true }
  for (const policy of [
    { engine: 'tesseract' },
    { localOnlyVision: true },
    { degraded: true },
    { remainingMs: 1199 },
    { remainingMs: Number.NaN },
  ]) {
    const result = await verifyUncertainAutoOcrResult(local, {
      engine: 'auto', remainingMs: 5000, ...policy,
      verifyVision: async () => { throw Error('review must not run') },
    })
    assert.equal(result, local, 'review must keep native local text under blocked policy')
  }
  const confident = { ...local, uncertain: false }
  const result = await verifyUncertainAutoOcrResult(confident, {
    engine: 'auto', remainingMs: 5000,
    verifyVision: async () => { throw Error('confident text must not trigger review') },
  })
  assert.equal(result, confident)
})

test('issue #836: ncnn review failure or empty response retains uncertain local evidence', async () => {
  const local = { engine: 'ncnn', text: '原始低置信度结果', uncertain: true }
  const allowed = { engine: 'auto', remainingMs: 5000 }
  for (const verifyVision of [
    async () => { throw Error('backend unavailable') },
    async () => ({ ok: false, text: 'hallucination' }),
    async () => ({ text: '' }),
    async () => null,
  ]) {
    assert.equal(await verifyUncertainAutoOcrResult(local, { ...allowed, verifyVision }), local)
  }
  const controller = new AbortController()
  await assert.rejects(verifyUncertainAutoOcrResult(local, {
    ...allowed,
    verifyVision: async () => { controller.abort(); throw Error('turn cancelled') },
    checkAbort: error => { if (controller.signal.aborted) throw error },
  }), /turn cancelled/)
})
