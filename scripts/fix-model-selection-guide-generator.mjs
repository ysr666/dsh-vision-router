import { readFileSync, writeFileSync } from 'node:fs'

const path = 'scripts/apply-model-selection-guide.mjs'
let source = readFileSync(path, 'utf8')

// Keep guided mode usable for the current page even when localStorage is blocked.
const oldGuideState = `    let visionGuidePrompt\n\n    function readVisionGuideActive() {\n      try {\n        return !!(window.localStorage && window.localStorage.getItem(VISION_GUIDE_STORAGE_KEY) === 'active')\n      } catch {\n        return false\n      }\n    }\n    function writeVisionGuideActive(active) {\n      try {\n        if (!window.localStorage) return\n        if (active) window.localStorage.setItem(VISION_GUIDE_STORAGE_KEY, 'active')\n        else window.localStorage.removeItem(VISION_GUIDE_STORAGE_KEY)\n      } catch {\n        // Best effort only; the current page can still run the guide.\n      }\n    }`
const newGuideState = `    let visionGuidePrompt\n    let visionGuideActiveMemory = false\n\n    function readVisionGuideActive() {\n      try {\n        if (window.localStorage && window.localStorage.getItem(VISION_GUIDE_STORAGE_KEY) === 'active') return true\n      } catch {\n        // Fall through to page-memory state when storage access is blocked.\n      }\n      return visionGuideActiveMemory\n    }\n    function writeVisionGuideActive(active) {\n      visionGuideActiveMemory = active === true\n      try {\n        if (!window.localStorage) return\n        if (active) window.localStorage.setItem(VISION_GUIDE_STORAGE_KEY, 'active')\n        else window.localStorage.removeItem(VISION_GUIDE_STORAGE_KEY)\n      } catch {\n        // Page-memory state still keeps the guide functional for this load.\n      }\n    }`
if (!source.includes(oldGuideState)) throw new Error('guide state anchor not found')
source = source.replace(oldGuideState, newGuideState)

// The first generator used regex literals containing "/" in human-facing copy,
// which made the generated test file invalid JavaScript. Use exact substring
// assertions instead; they are clearer for this static integration guard.
const marker = "tests += `\\n\\ntest('model-selection guide separates session and vision models and targets the vision chain'"
const start = source.indexOf(marker)
if (start === -1) throw new Error('generated-test anchor not found')
source = source.slice(0, start) + `tests += \`\\n\\ntest('model-selection guide separates session and vision models and targets the vision chain', () => {\\n  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')\\n  assert.equal(source.includes(\\\"onboardingStep1Title: '1 · 会话 / 文字模型'\\\"), true)\\n  assert.equal(source.includes(\\\"onboardingStep2Body: '打开「设置 → 插件 → Vision Router」\\\"), true)\\n  assert.equal(source.includes(\\\"onboardingStep1Title: '1 · Session / text model'\\\"), true)\\n  assert.equal(source.includes('Settings → Plugins → Vision Router'), true)\\n  assert.equal(source.includes(\\\"VISION_GUIDE_STORAGE_KEY = 'dsh-vision-router:guide:vision-backend-v1'\\\"), true)\\n  assert.equal(source.includes('visionGuideActiveMemory = false'), true)\\n  assert.equal(source.includes('startVisionSettingsGuide(t)'), true)\\n  assert.equal(source.includes(\\\"id: 'vr-vision-backend-chain'\\\"), true)\\n  assert.equal(source.includes(\\\"'data-vr-guide-target': 'vision-backend'\\\"), true)\\n  assert.equal(source.includes(\\\"target.scrollIntoView({ behavior: 'smooth', block: 'center' })\\\"), true)\\n  assert.equal(source.includes('if (!open) setOpen(true)'), true)\\n})\\n\`\nwriteFileSync(testPath, tests)\n`

writeFileSync(path, source)
