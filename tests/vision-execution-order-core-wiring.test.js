import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('production core consumers apply scoped execution order only after building eligible bases', async () => {
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')

  assert.match(
    source,
    /import \{ currentVisionExecutionOrder \} from '\.\/lib\/vision-execution-order\.js'/,
    'index.js must read the scoped execution order directly',
  )
  assert.match(
    source,
    /import \{ applyVisionExecutionOrder \} from '\.\/lib\/vision-execution-order-apply\.js'/,
    'index.js must use the reorder-only application helper',
  )
  assert.match(
    source,
    /const routingPairs = \(\) => \{[\s\S]*?const base = \[\.\.\.native, \.\.\.local, \.\.\.http\]\.filter\([\s\S]*?return applyVisionExecutionOrder\(base, currentVisionExecutionOrder\(\)\)/,
    'whole-turn routing must build/filter/dedupe the eligible base before applying scoped order',
  )
  assert.match(
    source,
    /const resolveToolVisionPairs = async \(\) => \{[\s\S]*?const capabilities = await collectVisionBackendCapabilities\(\)[\s\S]*?return applyVisionExecutionOrder\(out, currentVisionExecutionOrder\(\)\)/,
    'tool routing must finish explicit/local/discovery eligibility before applying scoped order',
  )
})
