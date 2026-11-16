import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { apply, Config } from '../index.js'

const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function mockHost(config0 = {}) {
  const tools = new Map()
  let current = Config({ ...config0 })
  const registrations = new Map()
  const ctx = {
    get(name) {
      if (name === 'settings') return { get: () => undefined }
      if (name === 'credentials') return { resolve: async () => ({ value: '' }) }
      if (name === 'attachments') return {
        saveImage: async input => ({ attachmentId: 'x', mediaType: input.mediaType }),
        readImage: async () => ({ data: SAMPLE_PNG, ref: { mediaType: 'image/png' } }),
      }
      if (name === 'fs') return {
        resolve: async input => input,
        readBytes: async target => readFileSync(target),
      }
      return undefined
    },
    logger: { warn() {}, info() {}, error() {} },
    effect(fn) { if (typeof fn === 'function') fn(); return () => {} },
    on() {},
    inject(_deps, cb) {
      cb({ settings: { register: () => ({
        get: () => current, watch: () => () => {},
      }) }, effect: () => () => {} })
    },
    tools: { register(def) { tools.set(def.name, def); return () => {} } },
    llm: {
      registerAdapter(providers, adapter) {
        for (const name of providers) registrations.set(name, adapter)
        const handle = () => {}
        handle.replace = () => {}
        return handle
      },
      registration(name) {
        const adapter = registrations.get(name)
        if (!adapter) throw new Error('unknown mock provider')
        return { adapter }
      },
      registerConfigurableProviders: () => ({ replace() {} }),
      listProviders: () => [],
      listModels: async () => [],
      stream: async function* () { yield { type: 'finish', reason: { kind: 'stop' } } },
    },
  }
  apply(ctx, current)
  return { tools }
}

async function ocrTool(config) {
  const harness = mockHost(config)
  const activate = harness.tools.get('vision_activate')
  assert.ok(activate, 'vision_activate must register')
  await activate.execute({}, {})
  const tool = harness.tools.get('vision_ocr')
  assert.ok(tool, 'vision_ocr must register')
  return tool
}

test('explicit Tesseract overrides the native canary even when disabled', async () => {
  const old = process.env.DVR_NCNN_OCR_CANARY
  delete process.env.DVR_NCNN_OCR_CANARY
  const folder = mkdtempSync(path.join(os.tmpdir(), 'dvr-ocr-no-canary-'))
  try {
    const img = path.join(folder, 'tiny.png')
    writeFileSync(img, SAMPLE_PNG)
    const tool = await ocrTool({
      freeFallback: false, ocrEngine: 'auto', ocrTimeoutMs: 1000,
    })
    try {
      const outcome = JSON.parse(await tool.execute(
        { image: img, engine: 'tesseract' },
        { agent: { session: { header: { cwd: folder } } } },
      ))
      assert.equal(outcome.engine, 'tesseract')
    } catch (error) {
      // Some local Tesseract installations fail on 1x1 images; that is an
      // existing local-binary failure, not evidence of a native switch.
      assert.match(String(error), /vision_ocr: local tesseract failed/)
    }
  } finally {
    rmSync(folder, { recursive: true, force: true })
    if (old === undefined) delete process.env.DVR_NCNN_OCR_CANARY
    else process.env.DVR_NCNN_OCR_CANARY = old
  }
})

test('owner-opted experimental canary uses real ncnn inside Host vision_ocr', async (t) => {
  const photo = process.env.DVR_OCR_PRIVATE_PHOTO
  const executable = process.env.DVR_OCR_PRIVATE_BIN
  const models = process.env.DVR_OCR_PRIVATE_MODELS
  if (!photo || !executable || !models) {
    t.skip('private photo/model/binary not packaged')
    return
  }
  const previous = {
    flag: process.env.DVR_NCNN_OCR_CANARY,
    exe: process.env.DVR_NCNN_OCR_EXECUTABLE,
    models: process.env.DVR_NCNN_OCR_MODELS,
  }
  process.env.DVR_NCNN_OCR_CANARY = '1'
  process.env.DVR_NCNN_OCR_EXECUTABLE = executable
  process.env.DVR_NCNN_OCR_MODELS = models
  try {
    const tool = await ocrTool({ freeFallback: false, ocrEngine: 'auto', localOnlyVision: true })
    const result = JSON.parse(await tool.execute(
      { image: photo },
      { agent: { session: { header: { cwd: path.dirname(photo) } } } },
    ))
    assert.equal(result.engine, 'ncnn')
    assert.ok(result.text.includes('C2H2(g)'))
    assert.equal(result.uncertain, true)
    assert.ok(result.review?.numericOrFormulaRisks?.length > 0)
  } finally {
    for (const [key, name] of [
      ['flag', 'DVR_NCNN_OCR_CANARY'],
      ['exe', 'DVR_NCNN_OCR_EXECUTABLE'],
      ['models', 'DVR_NCNN_OCR_MODELS'],
    ]) {
      if (previous[key] === undefined) delete process.env[name]
      else process.env[name] = previous[key]
    }
  }
})

test('installed PP-OCRv6 is used by ordinary auto without the legacy canary flag', async (t) => {
  if (!['darwin-arm64','win32-x64'].includes(process.platform+'-'+process.arch)) return t.skip('approved native platform only')
  const photo = process.env.DVR_OCR_PRIVATE_PHOTO
  const installedWorker = path.join(os.homedir(), '.dsh-vision-router', 'ocr', 'ppocrv6-small', process.platform === 'win32' ? 'worker.exe' : 'worker')
  if (!photo || !existsSync(installedWorker)) return t.skip('private photo / owner installation absent')
  const previous = {
    flag: process.env.DVR_NCNN_OCR_CANARY,
    exe: process.env.DVR_NCNN_OCR_EXECUTABLE,
    models: process.env.DVR_NCNN_OCR_MODELS,
  }
  delete process.env.DVR_NCNN_OCR_CANARY
  delete process.env.DVR_NCNN_OCR_EXECUTABLE
  delete process.env.DVR_NCNN_OCR_MODELS
  try {
    const tool = await ocrTool({ freeFallback: false, ocrEngine: 'auto', localOnlyVision: true })
    const result = JSON.parse(await tool.execute(
      { image: photo },
      { agent: { session: { header: { cwd: path.dirname(photo) } } } },
    ))
    assert.equal(result.engine, 'ncnn')
    assert.ok(result.text.includes('C2H2(g)'))
    assert.equal(result.uncertain, true)
  } finally {
    for (const [field, key] of [
      ['flag','DVR_NCNN_OCR_CANARY'],
      ['exe','DVR_NCNN_OCR_EXECUTABLE'],
      ['models','DVR_NCNN_OCR_MODELS'],
    ]) {
      if (previous[field] === undefined) delete process.env[key]
      else process.env[key] = previous[field]
    }
  }
})
