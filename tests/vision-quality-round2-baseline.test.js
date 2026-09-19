import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ROUND2_CASES, ROUND2_SUITE_REVISION, validateRound2Corpus } from '../quality/vision-round2/corpus.mjs'
import { scoreRound2Result, summarizeRound2Results } from '../quality/vision-round2/scorer.mjs'
import {
  assertSurface, cloneRuntimeTemplate, modelSelectionRequest, parseArgs, reasoningEffortOption, redactHostLog, requestSurface,
} from '../quality/vision-round2/run-host-api.mjs'

test('Round 2 seed corpus is small, balanced and deterministic', () => {
  const summary = validateRound2Corpus()
  assert.equal(summary.total, 36)
  assert.deepEqual(summary.counts, {
    text_precision: 8,
    multi_image_identity: 6,
    small_target: 6,
    ui_state: 6,
    uncertainty: 5,
    relevance_noise: 5,
  })
})

test('Round 2 suite v2 makes the multi-image ID contract unambiguous', () => {
  assert.equal(ROUND2_SUITE_REVISION, 2)
  const item = ROUND2_CASES.find(candidate => candidate.id === 'multi-id-01')
  assert.ok(item)
  assert.match(item.question, /完整ID/u)
  assert.match(item.question, /保留ID中的字母前缀/u)
  assert.deepEqual(item.expected, ['A=A17; B=B42'])
})

test('exact text scoring preserves case and confusable characters', () => {
  assert.equal(scoreRound2Result({ id: 'text-confusable-01', answer: 'O0I1l-7Q2' }).pass, true)
  assert.equal(scoreRound2Result({ id: 'text-confusable-01', answer: 'o0i1l-7q2' }).pass, false)
  assert.equal(scoreRound2Result({ id: 'text-confusable-01', answer: 'O0I11-7Q2' }).pass, false)
})

test('report keeps correctness separate from advisory tool-call efficiency', () => {
  const report = summarizeRound2Results([
    { id: 'ui-state-01', answer: 'ON', toolCalls: 9 },
    { id: 'ui-state-02', answer: 'ON', toolCalls: 1 },
  ])
  assert.equal(report.passed, 1)
  assert.equal(report.failed, 1)
  assert.equal(report.extraToolCallCases, 1)
  assert.equal(report.categories.ui_state.total, 2)
  assert.equal(report.categories.ui_state.failed, 1)
  assert.equal(report.missing.length, ROUND2_CASES.length - 2)
})

test('renderer produces PNG fixtures and manifest without changing the corpus', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dvr-quality-r2-'))
  try {
    const run = spawnSync(process.execPath, ['quality/vision-round2/render-fixtures.mjs', root], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr || run.stdout)
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))
    assert.equal(manifest.cases.length, 36)
    assert.deepEqual(manifest.cases[8].images.length, 2)
    const png = await readFile(path.join(root, manifest.cases[0].images[0]))
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('run template has exactly one blank result row per case', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dvr-quality-r2-template-'))
  try {
    const target = path.join(root, 'results.template.jsonl')
    const run = spawnSync(process.execPath, ['quality/vision-round2/make-run-template.mjs', target], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr || run.stdout)
    const rows = (await readFile(target, 'utf8')).trim().split(/\r?\n/).map(JSON.parse)
    assert.equal(rows.length, 36)
    assert.deepEqual(rows.map((row) => row.id), ROUND2_CASES.map((item) => item.id))
    assert.equal(rows.every((row) => row.answer === '' && row.toolCalls === null), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('Host API runner keeps launch credentials out of persisted logs', () => {
  assert.equal(
    redactHostLog('dsh web: http://127.0.0.1:1234/?token=secret-value'),
    'dsh web: http://127.0.0.1:1234/?token=<redacted>',
  )
  assert.equal(redactHostLog('plain log line'), 'plain log line')
})

test('Host API runner parses explicit benchmark selectors and rejects unknown flags', () => {
  assert.deepEqual(parseArgs([
    '--runtime-template', '/tmp/base', '--dsh-spec', '@deepseek-ai/dsh@0.1.5-rc.1',
    '--ids', 'a,b', '--resume',
  ]), {
    'runtime-template': '/tmp/base',
    'dsh-spec': '@deepseek-ai/dsh@0.1.5-rc.1',
    ids: 'a,b',
    resume: true,
  })
  assert.throws(() => parseArgs(['--mystery']), /unknown option/u)
})

test('Host API runner can omit reasoning effort for models that do not expose reasoning levels', () => {
  assert.equal(reasoningEffortOption(undefined), 'high')
  assert.equal(reasoningEffortOption('medium'), 'medium')
  assert.equal(reasoningEffortOption('off'), 'off')
  assert.equal(reasoningEffortOption('none'), undefined)

  assert.deepEqual(modelSelectionRequest('session-1', {
    provider: 'packy-vision',
    model: 'deepseek-v4-flash',
    reasoningEffort: undefined,
  }), {
    sessionId: 'session-1',
    provider: 'packy-vision',
    model: 'deepseek-v4-flash',
  })
  assert.deepEqual(modelSelectionRequest('session-2', {
    provider: 'deepseek-vision',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  }), {
    sessionId: 'session-2',
    provider: 'deepseek-vision',
    model: 'deepseek-flash',
    reasoningEffort: 'high',
  })
})

test('Host API runner clones only reusable DSH profile state', async () => {
  const template = await mkdtemp(path.join(tmpdir(), 'dvr-r2-runtime-template-'))
  const runtime = await mkdtemp(path.join(tmpdir(), 'dvr-r2-runtime-copy-'))
  try {
    const dsh = path.join(template, '.dsh')
    const profile = path.join(dsh, 'profiles', 'web')
    const plugin = path.join(profile, 'node_modules', 'dsh-vision-router')
    await mkdir(path.join(plugin, 'lib'), { recursive: true })
    await mkdir(path.join(plugin, 'quality', 'vision-round2'), { recursive: true })
    await mkdir(path.join(plugin, 'tests'), { recursive: true })
    await mkdir(path.join(plugin, 'scripts'), { recursive: true })
    await writeFile(path.join(dsh, 'settings.yaml'), 'agent-default-model: {}\n')
    await writeFile(path.join(dsh, '.credentials.yaml'), 'test: placeholder\n')
    await writeFile(path.join(profile, 'package.json'), '{}\n')
    await writeFile(path.join(plugin, 'package.json'), JSON.stringify({ files: ['index.js', 'lib'] }))
    await writeFile(path.join(plugin, 'index.js'), 'export const ok = true\n')
    await writeFile(path.join(plugin, 'lib', 'runtime.js'), 'export const runtime = true\n')
    await writeFile(path.join(plugin, 'quality', 'vision-round2', 'corpus.mjs'), 'EXPECTED_ANSWER\n')
    await writeFile(path.join(plugin, 'tests', 'vision-quality-round2-baseline.test.js'), 'EXPECTED_ANSWER\n')
    await writeFile(path.join(plugin, 'scripts', 'dev-only.mjs'), 'EXPECTED_ANSWER\n')
    for (const ephemeral of ['sessions', 'attachments', 'logs', 'storages', 'llm-deepseek']) {
      await mkdir(path.join(dsh, ephemeral), { recursive: true })
      await writeFile(path.join(dsh, ephemeral, 'sentinel.txt'), 'must-not-copy\n')
    }

    await cloneRuntimeTemplate(template, runtime)
    assert.match(await readFile(path.join(runtime, '.dsh', 'settings.yaml'), 'utf8'), /agent-default-model/u)
    assert.equal(await readFile(path.join(runtime, '.dsh', 'profiles', 'web', 'package.json'), 'utf8'), '{}\n')
    const copiedPlugin = path.join(runtime, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-vision-router')
    assert.match(await readFile(path.join(copiedPlugin, 'index.js'), 'utf8'), /ok = true/u)
    assert.match(await readFile(path.join(copiedPlugin, 'lib', 'runtime.js'), 'utf8'), /runtime = true/u)
    for (const devOnly of ['quality', 'tests', 'scripts']) {
      await assert.rejects(readFile(path.join(copiedPlugin, devOnly, 'sentinel.txt')), { code: 'ENOENT' })
      await assert.rejects(readFile(path.join(copiedPlugin, devOnly === 'quality' ? 'vision-round2/corpus.mjs' : devOnly === 'tests' ? 'vision-quality-round2-baseline.test.js' : 'dev-only.mjs')), { code: 'ENOENT' })
    }
    for (const ephemeral of ['sessions', 'attachments', 'logs', 'storages', 'llm-deepseek']) {
      await assert.rejects(readFile(path.join(runtime, '.dsh', ephemeral, 'sentinel.txt')), { code: 'ENOENT' })
    }
  } finally {
    await rm(template, { recursive: true, force: true })
    await rm(runtime, { recursive: true, force: true })
  }
})

test('Host API runner refuses an installed plugin symlink that escapes the cloned runtime', async () => {
  const template = await mkdtemp(path.join(tmpdir(), 'dvr-r2-symlink-template-'))
  const runtime = await mkdtemp(path.join(tmpdir(), 'dvr-r2-symlink-runtime-'))
  const external = await mkdtemp(path.join(tmpdir(), 'dvr-r2-external-plugin-'))
  try {
    const profile = path.join(template, '.dsh', 'profiles', 'web')
    await mkdir(path.join(profile, 'node_modules'), { recursive: true })
    await writeFile(path.join(template, '.dsh', 'settings.yaml'), 'agent-default-model: {}\n')
    await writeFile(path.join(profile, 'package.json'), '{}\n')
    await writeFile(path.join(external, 'package.json'), JSON.stringify({ files: ['index.js'] }))
    await writeFile(path.join(external, 'index.js'), 'export const external = true\n')
    await symlink(external, path.join(profile, 'node_modules', 'dsh-vision-router'))
    await assert.rejects(
      cloneRuntimeTemplate(template, runtime),
      /external dsh-vision-router symlink/u,
    )
    assert.match(await readFile(path.join(external, 'index.js'), 'utf8'), /external = true/u)
  } finally {
    await rm(template, { recursive: true, force: true })
    await rm(runtime, { recursive: true, force: true })
    await rm(external, { recursive: true, force: true })
  }
})

test('Host API runner verifies the selected model and published DVR tool surface', () => {
  const events = [{
    type: 'request/header',
    data: { header: {
      config: { provider: 'deepseek-vision', model: 'deepseek-flash' },
      tools: [{ name: 'bash' }, { name: 'vision_ocr' }, { name: 'vision_describe' }],
    } },
  }]
  const surface = requestSurface(events)
  assert.deepEqual(surface, {
    headers: 1,
    provider: 'deepseek-vision',
    model: 'deepseek-flash',
    visionToolCount: 2,
  })
  assert.doesNotThrow(() => assertSurface(surface, {
    provider: 'deepseek-vision', model: 'deepseek-flash', expectVisionTools: 2,
  }, 'case-1'))
  assert.throws(() => assertSurface(surface, {
    provider: 'deepseek-vision', model: 'deepseek-flash', expectVisionTools: 14,
  }, 'case-1'), /expected 14 Vision Router tools/u)
})
