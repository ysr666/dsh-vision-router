import assert from 'node:assert/strict'
import test from 'node:test'

import { createDesktopScreenshotTool } from '../lib/desktop-screenshot-tool.js'

test('Linux desktop screenshot captures a real X11 root display as PNG', {
  skip: process.platform !== 'linux',
}, async () => {
  let captured = null
  const tool = createDesktopScreenshotTool({
    current: () => ({ desktopScreenshot: true }),
    timeoutMs: () => 5000,
    saveArtifact: async (_exec, name, data) => {
      captured = Buffer.from(data)
      return `/artifacts/${name}`
    },
    stringOutput: { type: 'string' },
    instantLocalStyle: () => 'plain',
  })

  const result = JSON.parse(await tool.execute({}, {}))
  assert.ok(captured?.length > 8)
  assert.deepEqual([...captured.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.match(result.path, /^\/artifacts\/screenshot-\d+\.png$/)
  assert.equal(result.bytes, captured.length)
})
