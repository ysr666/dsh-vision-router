import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assessTesseractOcr,
  ocrWithTesseractAdaptive,
  parseTesseractTsv,
  selectTesseractOcrCandidate,
} from '../lib/core-primitives.js'

function tsv(words) {
  const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext'
  return [header, ...words.map(([text, conf], index) =>
    `5\t1\t1\t1\t1\t${index + 1}\t0\t0\t10\t10\t${conf}\t${text}`,
  )].join('\n')
}

function scriptedExec(passes, calls) {
  return async (_file, args) => {
    const psm = Number(args[args.indexOf('--psm') + 1])
    const isTsv = args.at(-1) === 'tsv'
    calls.push({ psm, isTsv })
    const pass = passes[psm]
    if (!pass) throw new Error(`unexpected psm ${psm}`)
    if (isTsv && pass.tsvError) throw new Error(pass.tsvError)
    return { stdout: isTsv ? pass.tsv : pass.text }
  }
}

test('parseTesseractTsv ignores structural rows and keeps word confidence', () => {
  const parsed = parseTesseractTsv(tsv([['Cable', 91.2], ['$15', 94.8]]))
  assert.deepEqual(parsed, [
    { text: 'Cable', confidence: 91.2 },
    { text: '$15', confidence: 94.8 },
  ])
})
test('assessment marks low-confidence layouts and confusable glyph runs uncertain', () => {
  const table = assessTesseractOcr('a\nee ee', tsv([['a', 21.6], ['ee', 23.9], ['ee', 35.7]]), 6)
  assert.equal(table.uncertain, true)
  assert.ok(table.quality < 30)

  const code = assessTesseractOcr('const token = "I1001";', tsv([
    ['const', 96], ['token', 96], ['=', 93], ['"I1001";', 89],
  ]), 6)
  assert.equal(code.uncertain, true)
  assert.deepEqual(code.riskyTokens, ['"I1001";'])

  const ordinary = assessTesseractOcr('Order ID: R-4821-B8', tsv([
    ['Order', 96], ['ID:', 93], ['R-4821-B8', 85],
  ]), 6)
  assert.equal(ordinary.uncertain, false)
})

test('candidate selection needs a material quality gain before changing layout mode', () => {
  const psm6 = { psm: 6, text: 'weak', quality: 25 }
  const psm3 = { psm: 3, text: 'table', quality: 90 }
  const psm11 = { psm: 11, text: 'sparse table', quality: 92 }
  assert.equal(selectTesseractOcrCandidate([psm6, psm3, psm11]).psm, 3)
})
test('adaptive OCR keeps the high-confidence PSM 6 fast path', async () => {
  const calls = []
  const result = await ocrWithTesseractAdaptive(Buffer.from('png'), 12000, {
    exec: scriptedExec({
      6: {
        text: 'Order ID: R-4821-B8',
        tsv: tsv([['Order', 96], ['ID:', 93], ['R-4821-B8', 85]]),
      },
    }, calls),
  })
  assert.equal(result.text, 'Order ID: R-4821-B8')
  assert.equal(result.psm, 6)
  assert.equal(result.uncertain, false)
  assert.deepEqual(result.attemptedPsms, [6])
  assert.deepEqual(calls, [{ psm: 6, isTsv: false }, { psm: 6, isTsv: true }])
})

test('adaptive OCR repairs a weak table layout with PSM 3', async () => {
  const calls = []
  const result = await ocrWithTesseractAdaptive(Buffer.from('png'), 12000, {
    exec: scriptedExec({
      6: { text: 'a\nee ee', tsv: tsv([['a', 21], ['ee', 24], ['ee', 36]]) },
      3: { text: 'Item Amount\nCamera $120\nCable $15\nTotal $135', tsv: tsv([['Item', 92], ['Amount', 93], ['Camera', 94], ['$120', 91], ['Cable', 93], ['$15', 90], ['Total', 95], ['$135', 92]]) },
      11: { text: 'Item\nAmount\nCamera\n$120\nCable\n$15\nTotal\n$135', tsv: tsv([['Item', 93], ['Amount', 94], ['Camera', 94], ['$120', 92], ['Cable', 94], ['$15', 91], ['Total', 95], ['$135', 93]]) },
    }, calls),
  })
  assert.equal(result.psm, 3)
  assert.match(result.text, /Cable \$15/)
  assert.equal(result.uncertain, false)
  assert.deepEqual(result.attemptedPsms, [6, 3, 11])
})
test('adaptive OCR preserves uncertainty for confusable character runs', async () => {
  const result = await ocrWithTesseractAdaptive(Buffer.from('png'), 12000, {
    exec: scriptedExec({
      6: { text: 'Device code 00I1L-7Q2', tsv: tsv([['Device', 96], ['code', 96], ['00I1L-7Q2', 44]]) },
      3: { text: 'Device code 00I1L-7Q2', tsv: tsv([['Device', 96], ['code', 96], ['00I1L-7Q2', 44]]) },
      11: { text: 'Device code\n00111-7Q2', tsv: tsv([['Device', 96], ['code', 96], ['00111-7Q2', 63]]) },
    }, []),
  })
  assert.equal(result.psm, 11)
  assert.equal(result.uncertain, true)
  assert.deepEqual(result.riskyTokens, ['00111-7Q2'])
})

test('an optional review failure never discards a successful local OCR result', async () => {
  const calls = []
  const result = await ocrWithTesseractAdaptive(Buffer.from('png'), 12000, {
    exec: scriptedExec({
      6: { text: 'Device code 00I1L-7Q2', tsv: tsv([['Device', 96], ['code', 96], ['00I1L-7Q2', 44]]) },
      3: { text: 'unused', tsv: '', tsvError: 'review failed' },
      11: { text: 'Device code 00111-7Q2', tsv: tsv([['Device', 96], ['code', 96], ['00111-7Q2', 63]]) },
    }, calls),
  })
  assert.ok(result.text.length > 0)
  assert.equal(result.uncertain, true)
  assert.deepEqual(result.attemptedPsms, [6, 3, 11])
})


test('adaptive OCR normalizes invalid timeout budgets before dispatch', async () => {
  const seenTimeouts = []
  const exec = async (_file, args, options) => {
    seenTimeouts.push(options.timeout)
    const psm = Number(args[args.indexOf('--psm') + 1])
    assert.equal(psm, 6)
    if (args.at(-1) === 'tsv') return { stdout: tsv([['READY', 95]]) }
    return { stdout: 'READY' }
  }
  for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    seenTimeouts.length = 0
    const result = await ocrWithTesseractAdaptive(Buffer.from('png'), timeoutMs, { exec })
    assert.equal(result.text, 'READY')
    assert.ok(seenTimeouts.every((value) => Number.isFinite(value) && value > 0 && value <= 12000))
  }
})
