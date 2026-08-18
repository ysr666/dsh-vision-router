import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveArtifactRootPath } from '../index.js'

test('artifact root refuses lexical workspace traversal and absolute paths', () => {
  const workspace = path.resolve('/tmp/vision-workspace')
  assert.equal(resolveArtifactRootPath(workspace, '.dsh-vision-router/artifacts'), path.join(workspace, '.dsh-vision-router/artifacts'))
  assert.throws(() => resolveArtifactRootPath(workspace, '../../escape'), /inside|relative/)
  assert.throws(() => resolveArtifactRootPath(workspace, path.resolve('/tmp/outside')), /relative/)
})
