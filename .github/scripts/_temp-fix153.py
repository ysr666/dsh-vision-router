from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'missing anchor: {label}')
    return text.replace(old, new, 1)

p = Path('index.js')
s = p.read_text()

s = replace_once(s, """        if (paths.length + attachmentIds.length === 0 || paths.length + attachmentIds.length > 4) {
          throw new Error('vision_describe: provide 1-4 images via paths and/or attachmentIds')
        }

        for (const path of paths) {
""", """        if (paths.length + attachmentIds.length === 0 || paths.length + attachmentIds.length > 4) {
          throw new Error('vision_describe: provide 1-4 images via paths and/or attachmentIds')
        }
        // Preserve only durable upload ids for a deterministic offline fallback.
        // Never expose or guess the attachment store's private filesystem path.
        const materializableAttachmentIds = [...new Set([
          ...attachmentIds.map((id) => String(id)).filter((id) => isAttachmentIdInput(id)),
          ...paths.map((item) => String(item)).filter((item) => isAttachmentIdInput(item)),
        ])]

        for (const path of paths) {
""", 'materializable ids')

s = replace_once(s, """        return JSON.stringify(
          attempted.length > 0
            ? failure
            : { ...failure, code: VISION_RESULT_CODES.UNSUPPORTED_BACKEND },
        )
""", """        const baseFailure = attempted.length > 0
          ? failure
          : { ...failure, code: VISION_RESULT_CODES.UNSUPPORTED_BACKEND }
        if (materializableAttachmentIds.length > 0) {
          baseFailure.degradedAccess = {
            tool: 'vision_materialize',
            attachmentIds: materializableAttachmentIds,
            advice:
              'If another local/OCR tool requires a filesystem path, call vision_materialize for the uploaded attachment id. Do not guess a filename or the attachment store path.',
          }
        }
        return JSON.stringify(baseFailure)
""", 'failure degradedAccess')

s = replace_once(s, """    const stringOutput = {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    }

    const visionPresentOutput = {
""", """    const stringOutput = {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    }

    // issue #153: materialize an authorized attachment into the workspace for
    // file_path-only local parsers without coupling them to DSH storage internals.
    deepToolDefs.push({
      name: 'vision_materialize',
      description:
        'Copy an uploaded image attachment (sha256:...) or readable local image into the session workspace and return a real filesystem path. ' +
        'This tool performs NO vision model/network call. Use it after vision_describe/vision_bootstrap returns ok:false when a local OCR/parser accepts only file_path. ' +
        'Never guess the attachment store path or search for a same-named file.',
      parameters: {
        type: 'object',
        properties: {
          image: { type: 'string', description: 'Uploaded image attachment id (recommended, e.g. sha256:...) or a readable local image path' },
        },
        required: ['image'],
        additionalProperties: false,
      },
      output: stringOutput,
      async execute(args, exec) {
        const source = String(args.image ?? '')
        const { bytes, mediaType } = await readImageBytes(exec, source)
        const extension = mediaType === 'image/jpeg'
          ? 'jpg'
          : mediaType === 'image/webp'
            ? 'webp'
            : mediaType === 'image/gif'
              ? 'gif'
              : 'png'
        const target = await saveArtifact(exec, `${artifactStem(source, 'materialized')}.${extension}`, bytes)
        return JSON.stringify({
          path: target,
          mediaType,
          bytes: bytes.length,
          ...(isAttachmentIdInput(source) ? { source } : {}),
          safeWorkspaceCopy: true,
        })
      },
    })

    const visionPresentOutput = {
""", 'materialize tool')

s = replace_once(s, """        'Only content-level uncertainty in a SUCCESSFUL answer justifies a second look (vision_crop, ' +
        'vision_ground or another vision_describe).',
""", """        'Only content-level uncertainty in a SUCCESSFUL answer justifies a second look (vision_crop, ' +
        'vision_ground or another vision_describe). If infrastructure failure leaves a file_path-only OCR/parser as the fallback, ' +
        'use vision_materialize on the uploaded attachment id; never guess a same-named local file or private attachment-store path.',
""", 'describe guidance')

s = s.replace(
    "vision_crop（裁剪放大）、vision_pixel_diff（像素对比验证）",
    "vision_materialize（附件落盘）、vision_crop（裁剪放大）、vision_pixel_diff（像素对比验证）",
)
s = s.replace(
    "vision_detect / vision_crop / ",
    "vision_detect / vision_materialize / vision_crop / ",
)
p.write_text(s)

p = Path('lib/client.js')
s = p.read_text()
s = replace_once(s, """    const ARTIFACT_TOOL_KEYS = [
      'vision_crop',
""", """    const ARTIFACT_TOOL_KEYS = [
      'vision_materialize',
      'vision_crop',
""", 'artifact card')
p.write_text(s)

p = Path('tests/core.test.js')
s = p.read_text()
s = replace_once(s,
    "const captured = { skills: [], on: new Map() }",
    "const captured = { skills: [], tools: [], on: new Map() }",
    'mock captured tools')
s = replace_once(s,
    "    tools: { register: () => () => {} },",
    "    tools: { register: (tool) => { captured.tools.push(tool); return () => {} } },",
    'mock tools register')
if 'vision_materialize exposes an authorized attachment' not in s:
    s += r'''

test('vision_materialize exposes an authorized attachment as a workspace file (issue #153)', async () => {
  const artifactsDir = '.tmp-vision-materialize-test'
  const config = { artifactsDir, freeFallback: false, progressiveTools: false }
  const { ctx, captured } = mockHarnessCtx({ attachments: true, config0: config })
  apply(ctx, Config(config))
  const tool = captured.tools.find((entry) => entry && entry.name === 'vision_materialize')
  assert.ok(tool, 'expected vision_materialize to be registered')
  assert.match(tool.description, /NO vision model\/network call/)

  const attachment = { attachmentId: 'sha256:40716778ccda05db57befec33e5af91973ecc810b4d5a8076b2c229421f388c2', mediaType: 'image/png', name: 'image.png' }
  const session = { id: 'issue-153', events: [], header: { cwd: process.cwd() } }
  const messages = [{ role: 'user', content: [{ type: 'image', attachment }, { type: 'text', text: 'look' }] }]
  const preStep = captured.on.get('agent/pre-step')
  assert.equal(typeof preStep, 'function')
  await preStep({ agent: { session }, messages, turn: 1 }, async () => ({ messages }))

  const output = JSON.parse(await tool.execute({ image: attachment.attachmentId }, { agent: { session } }))
  assert.equal(output.mediaType, 'image/png')
  assert.equal(output.safeWorkspaceCopy, true)
  assert.equal(output.source, attachment.attachmentId)
  assert.match(output.path, /materialized.*\.png$/)
  const { readFile, rm } = await import('node:fs/promises')
  assert.deepEqual(await readFile(output.path), Buffer.from('not-a-real-image'))
  await rm(new URL('../' + artifactsDir + '/', import.meta.url), { recursive: true, force: true })
})

test('vision_describe failure contract points attachment ids at vision_materialize (issue #153)', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /degradedAccess/)
  assert.match(source, /tool: 'vision_materialize'/)
  assert.match(source, /Do not guess a filename or the attachment store path/)
})
'''
p.write_text(s)

for name in ['README.md', 'README.zh.md']:
    p = Path(name)
    s = p.read_text()
    if '| `vision_materialize` |' not in s:
        lines = s.splitlines()
        for i, line in enumerate(lines):
            if line.startswith('| `vision_describe` |'):
                text = ('Copy an authorized attachment into the session workspace and return a filesystem path for local OCR/parser fallbacks; no vision/network call'
                        if name == 'README.md' else
                        '把已授权附件复制到会话工作区并返回真实文件路径，供本地 OCR/解析器降级使用；不调用视觉模型或网络')
                lines.insert(i + 1, f'| `vision_materialize` | {text} | image copy |')
                break
        s = '\n'.join(lines) + ('\n' if p.read_text().endswith('\n') else '')
    if name == 'README.md':
        s = s.replace('all thirteen deep tools', 'all fourteen deep tools')
        s = s.replace('bring the default deep-tool set to thirteen. Enabling the privacy-gated `vision_screenshot` at boot adds an optional fourteenth tool.', 'bring the default deep-tool set to fourteen. Enabling the privacy-gated `vision_screenshot` at boot adds an optional fifteenth tool.')
    p.write_text(s)
