// Assert the DVR candidate already committed on this diagnostic branch.
// Do not mutate source in Actions; the actual built plugin is exercised next.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const index = readFileSync('src/index.js','utf8')
assert.equal(index.split('presentationAliasOf: wrapperDelegateRoute()').length,2)
assert.equal(index.split('presentationAliasOf: provider').length,2)
const visibility = readFileSync('src/lib/vision-model-visibility-boundary-main.js','utf8')
assert.ok(visibility.includes("if (typeof models.rawDirectoryFor === 'function') return models;"))
const controls = readFileSync('src/lib/client-presentation-boundary-main.js','utf8')
assert.ok(controls.includes('? models.rawDirectoryFor(sessionId) : models.directoryFor(sessionId)'))
console.log('Verified committed DVR adapter aliases, shared projection and raw control seams')
