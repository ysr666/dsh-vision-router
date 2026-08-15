import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first === -1) throw new Error(`missing anchor: ${label}`)
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`anchor is not unique: ${label}`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

function patchIndex() {
  const file = 'index.js'
  let source = readFileSync(file, 'utf8')

  source = replaceOnce(
    source,
    `/** Marker text for an image the text-only model cannot see (see vision_describe). */\nfunction imageMarker(id) {`,
    `/**\n * Rewrite ONLY images nested below tool-result blocks. Top-level user images\n * are intentionally preserved for normal multimodal / vision-router flows.\n * Tool-produced images are different: built-in helpers such as read_image can\n * persist them inside a nested tool-result, and a text-only adapter will reject\n * that content forever once it enters session history. Sanitizing this shape at\n * the agent boundary makes tool results safe regardless of which route happens\n * to serve the next model request.\n */\nexport function rewriteToolResultImages(content, replace) {\n  if (!Array.isArray(content)) return { content, changed: false }\n  let changed = false\n\n  const walk = (blocks, insideToolResult) => {\n    let innerChanged = false\n    const next = []\n    for (const block of blocks) {\n      if (block && block.type === 'image' && insideToolResult) {\n        innerChanged = true\n        const out = replace(block)\n        if (out !== undefined && out !== null) {\n          if (Array.isArray(out)) next.push(...out)\n          else next.push(out)\n        }\n        continue\n      }\n      if (block && Array.isArray(block.content)) {\n        const nested = walk(block.content, insideToolResult || block.type === 'tool-result')\n        if (nested.changed) {\n          innerChanged = true\n          next.push({ ...block, content: nested.content })\n          continue\n        }\n      }\n      next.push(block)\n    }\n    return { content: innerChanged ? next : blocks, changed: innerChanged }\n  }\n\n  const result = walk(content, false)\n  changed = result.changed\n  return { content: changed ? result.content : content, changed }\n}\n\nexport function sanitizeToolResultImages(messages) {\n  let anyChanged = false\n  const rewritten = (messages ?? []).map((message) => {\n    if (!message || !Array.isArray(message.content)) return message\n    const result = rewriteToolResultImages(message.content, (block) => {\n      const attachment = block.attachment || {}\n      const id = attachment.attachmentId || attachment.id || 'unknown'\n      const name = attachment.name || 'tool image'\n      return {\n        type: 'text',\n        text:\n          \`[tool result produced image “\${name}”, attachment id “\${id}”. \` +\n          \`The image was kept out of the text-model request to prevent session corruption. \` +\n          \`To inspect it, call vision_describe with attachmentIds: [“\${id}”] when available, \` +\n          'or use a path-based vision tool. To show a generated image to the user, use vision_present instead of read_image.]',\n      }\n    })\n    if (result.changed) anyChanged = true\n    return result.changed ? { ...message, content: result.content } : message\n  })\n  return { messages: anyChanged ? rewritten : (messages ?? []), changed: anyChanged }\n}\n\n/** Marker text for an image the text-only model cannot see (see vision_describe). */\nfunction imageMarker(id) {`,
    'tool-result sanitizer helper',
  )

  source = replaceOnce(
    source,
    `/** Downscale bytes whose intrinsic pixel count exceeds maxPixels; returns original bytes on failure. */\nexport async function downscaleImage(bytes, maxPixels) {`,
    `/** Cross-platform Chrome/Chromium/Edge discovery for the HTML screenshot tool. */\nexport function chromiumCandidates(env = {}, platform = typeof process !== 'undefined' ? process.platform : '') {\n  const out = []\n  const add = (value) => {\n    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value)\n  }\n  add(env.CHROME_PATH)\n  add(env.PUPPETEER_EXECUTABLE_PATH)\n\n  if (platform === 'win32') {\n    const pf = env.PROGRAMFILES\n    const pfx86 = env['PROGRAMFILES(X86)']\n    const local = env.LOCALAPPDATA\n    if (pf) {\n      add(path.win32.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))\n      add(path.win32.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))\n    }\n    if (pfx86) {\n      add(path.win32.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'))\n      add(path.win32.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))\n    }\n    if (local) {\n      add(path.win32.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))\n      add(path.win32.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))\n      add(path.win32.join(local, 'Chromium', 'Application', 'chrome.exe'))\n    }\n  } else if (platform === 'darwin') {\n    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')\n    add('/Applications/Chromium.app/Contents/MacOS/Chromium')\n    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')\n  } else {\n    add('/usr/bin/google-chrome')\n    add('/usr/bin/google-chrome-stable')\n    add('/usr/bin/chromium')\n    add('/usr/bin/chromium-browser')\n    add('/usr/bin/microsoft-edge')\n    add('/usr/bin/microsoft-edge-stable')\n  }\n  return out\n}\n\n/** Downscale bytes whose intrinsic pixel count exceeds maxPixels; returns original bytes on failure. */\nexport async function downscaleImage(bytes, maxPixels) {`,
    'chromium candidate helper',
  )

  source = replaceOnce(
    source,
    `        const candidates = [\n          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',\n          '/Applications/Chromium.app/Contents/MacOS/Chromium',\n          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',\n        ]\n        const executablePath = candidates.find((p) => existsSync(p))`,
    `        const candidates = chromiumCandidates(\n          typeof process !== 'undefined' && process.env ? process.env : {},\n          typeof process !== 'undefined' ? process.platform : '',\n        )\n        const executablePath = candidates.find((p) => existsSync(p))`,
    'portable browser candidates',
  )

  source = replaceOnce(
    source,
    `            'vision_html_screenshot: no Chrome/Chromium/Edge found; install one to use this tool',`,
    `            'vision_html_screenshot: no Chrome/Chromium/Edge found; install one or set CHROME_PATH / PUPPETEER_EXECUTABLE_PATH',`,
    'portable browser error',
  )

  source = replaceOnce(
    source,
    `    const messages = decision.messages ?? payload.messages ?? []\n    const hasImage = messages.some((message) => blocksHaveImage(message && message.content))`,
    `    const rawMessages = decision.messages ?? payload.messages ?? []\n    // Hard invariant: tool-produced image blocks never reach a model request.\n    // This is deliberately route-agnostic, because merely having a wrapper\n    // registered does not prove that the current request is actually using it.\n    const sanitizedToolResults = sanitizeToolResultImages(rawMessages)\n    const messages = sanitizedToolResults.messages\n    const hasImage = messages.some((message) => blocksHaveImage(message && message.content))`,
    'pre-step tool-result hardening',
  )

  source = replaceOnce(
    source,
    `              : decision.messages ?? payload.messages ?? []`,
    `              : messages`,
    'auto-mount base uses sanitized messages',
  )

  source = replaceOnce(
    source,
    `      const base = decision.messages ?? payload.messages ?? []\n      const cleaned = rewriteHistoryImages(base, imageMemory)`,
    `      const base = messages\n      const cleaned = rewriteHistoryImages(base, imageMemory)`,
    'text-turn rewrite uses sanitized messages',
  )

  source = replaceOnce(
    source,
    `    return decision\n  })\n\n  if (routingEnabled()) {`,
    `    return sanitizedToolResults.changed ? { ...decision, messages } : decision\n  })\n\n  if (routingEnabled()) {`,
    'pre-step final sanitized return',
  )

  source = replaceOnce(
    source,
    `    deepToolDefs.push({\n      name: 'vision_pixel_diff',`,
    `    deepToolDefs.push({\n      name: 'vision_present',\n      description:\n        'Present a generated local image to the user as a SAFE artifact without inserting image content into model history. ' +\n        'Use this when you want to show a PNG/JPEG/WebP/GIF you created. Prefer this over read_image for presentation: ' +\n        'read_image is for model-side inspection, while vision_present is for user-facing delivery and returns text-only artifact metadata.',\n      parameters: {\n        type: 'object',\n        properties: {\n          image: { type: 'string', description: 'Local image path (png/jpeg/webp/gif)' },\n          label: { type: 'string', description: 'Optional short user-facing label for the image' },\n        },\n        required: ['image'],\n        additionalProperties: false,\n      },\n      output: stringOutput,\n      async execute(args, exec) {\n        const { bytes } = await readImageBytes(args.image)\n        // Normalize the presentation artifact to PNG so every client can open\n        // it consistently. Crucially, the tool result stays JSON text only.\n        const png = await sharp(bytes, { failOn: 'none' }).png().toBuffer()\n        const target = await saveArtifact(exec, \`\${artifactStem(args.image, 'present')}.png\`, png)\n        const meta = await sharp(png).metadata()\n        return JSON.stringify({\n          path: target,\n          label: typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : 'image',\n          width: meta.width ?? null,\n          height: meta.height ?? null,\n          bytes: png.length,\n          safePresentation: true,\n        })\n      },\n    })\n\n    deepToolDefs.push({\n      name: 'vision_pixel_diff',`,
    'vision_present tool',
  )

  source = source.replaceAll(
    `vision_extract_foreground（抠图）、vision_html_screenshot（页面截图）`,
    `vision_extract_foreground（抠图）、vision_present（安全展示图片）、vision_html_screenshot（页面截图）`,
  )
  source = source.replaceAll(
    `vision_extract_foreground / vision_html_screenshot`,
    `vision_extract_foreground / vision_present / vision_html_screenshot`,
  )
  source = source.replaceAll(
    `抠图或给页面截图`,
    `抠图、把生成图片安全展示给用户或给页面截图`,
  )
  source = source.replaceAll(
    `抠图用 \`vision_extract_foreground\`，本地 HTML 截图用 \`vision_html_screenshot\``,
    `抠图用 \`vision_extract_foreground\`，给用户展示生成图用 \`vision_present\`（不要用 read_image 代替），本地 HTML 截图用 \`vision_html_screenshot\``,
  )

  writeFileSync(file, source)
}

function patchClient() {
  const file = 'lib/client.js'
  let source = readFileSync(file, 'utf8')
  source = replaceOnce(
    source,
    `    const ARTIFACT_TOOL_KEYS = [\n      'vision_crop',`,
    `    const ARTIFACT_TOOL_KEYS = [\n      'vision_present',\n      'vision_crop',`,
    'vision_present artifact card',
  )
  writeFileSync(file, source)
}

function patchTests() {
  const file = 'tests/core.test.js'
  let source = readFileSync(file, 'utf8')
  source = replaceOnce(
    source,
    `  rewriteImagesDeep,\n  extractJson,`,
    `  rewriteImagesDeep,\n  sanitizeToolResultImages,\n  extractJson,`,
    'test sanitizer import',
  )
  source = replaceOnce(
    source,
    `  toRealPath,\n  callOpenAICompatible,`,
    `  toRealPath,\n  chromiumCandidates,\n  callOpenAICompatible,`,
    'test chromium import',
  )

  source += `\n\ntest('sanitizeToolResultImages removes nested read_image-style images but preserves user images', () => {\n  const userRef = { attachmentId: 'user-1', name: 'upload.png' }\n  const toolRef = { attachmentId: 'tool-1', name: 'generated.png' }\n  const input = [{\n    role: 'user',\n    content: [\n      { type: 'image', attachment: userRef },\n      {\n        type: 'tool-result',\n        content: [\n          { type: 'text', text: 'preview' },\n          { type: 'image', attachment: toolRef },\n        ],\n      },\n    ],\n  }]\n  const out = sanitizeToolResultImages(input)\n  assert.equal(out.changed, true)\n  assert.equal(out.messages[0].content[0].type, 'image')\n  const nested = out.messages[0].content[1].content\n  assert.equal(nested.some((block) => block.type === 'image'), false)\n  assert.match(nested[1].text, /tool-1/)\n  assert.match(nested[1].text, /vision_present/)\n})\n\ntest('sanitizeToolResultImages is identity-preserving when there is no nested image', () => {\n  const input = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]\n  const out = sanitizeToolResultImages(input)\n  assert.equal(out.changed, false)\n  assert.equal(out.messages, input)\n})\n\ntest('chromiumCandidates covers Windows, macOS, Linux and explicit overrides', () => {\n  const win = chromiumCandidates({\n    CHROME_PATH: 'D:\\\\Portable\\\\chrome.exe',\n    PROGRAMFILES: 'C:\\\\Program Files',\n    'PROGRAMFILES(X86)': 'C:\\\\Program Files (x86)',\n    LOCALAPPDATA: 'C:\\\\Users\\\\me\\\\AppData\\\\Local',\n  }, 'win32')\n  assert.equal(win[0], 'D:\\\\Portable\\\\chrome.exe')\n  assert.ok(win.some((value) => value.endsWith('Google\\\\Chrome\\\\Application\\\\chrome.exe')))\n  assert.ok(win.some((value) => value.endsWith('Microsoft\\\\Edge\\\\Application\\\\msedge.exe')))\n\n  const mac = chromiumCandidates({}, 'darwin')\n  assert.ok(mac.some((value) => value.includes('Google Chrome.app')))\n\n  const linux = chromiumCandidates({}, 'linux')\n  assert.ok(linux.includes('/usr/bin/google-chrome'))\n  assert.ok(linux.includes('/usr/bin/chromium'))\n})\n`
  writeFileSync(file, source)
}

patchIndex()
patchClient()
patchTests()
console.log('read-image hardening patch applied')
