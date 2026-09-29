import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('2.3 critical architecture gate aggregates runtime, Host and package contracts without changing main policy', async () => {
  const [gate, rc2] = await Promise.all([
    readFile(new URL('../.github/workflows/architecture-2.3-gate.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/dsh-020-rc2-validation.yml', import.meta.url), 'utf8'),
  ])

  assert.match(gate, /name: 2\.3 Critical Architecture Gate/)
  assert.match(gate, /push:\s*\n\s*branches: \[2\.3\.0\]/)
  assert.doesNotMatch(gate, /branches: \[main\]/)
  assert.match(gate, /node: \[22, 24\]/)
  assert.match(gate, /run: pnpm test/)
  assert.match(gate, /tests\/fetch-wrapper-composition\.test\.js/)
  assert.match(gate, /tests\/final-architecture-closure\.test\.js/)
  assert.match(gate, /tests\/session-vision-event-feed\.test\.js/)
  assert.match(gate, /tests\/client-script-carrier\.test\.js/)
  assert.match(gate, /tests\/security-property-fuzz\.test\.js/)
  assert.match(gate, /name: current Host 0\.1\.5-rc\.3/)
  assert.match(gate, /const v = '0\.1\.5-rc\.3'/)
  assert.match(gate, /run: node scripts\/dsh-host-contract-smoke\.mjs/)
  assert.match(gate, /name: DSH 0\.2\.0-rc\.2 \/ Desktop contract/)
  assert.match(gate, /uses: \.\/\.github\/workflows\/dsh-020-rc2-validation\.yml/)
  assert.match(gate, /name: critical-gate/)
  assert.match(gate, /needs: \[contracts, current-host-contract, rc2-desktop-contract\]/)
  assert.match(gate, /test "\$CONTRACTS_RESULT" = success/)
  assert.match(gate, /test "\$HOST_RESULT" = success/)
  assert.match(gate, /test "\$RC2_RESULT" = success/)
  assert.match(rc2, /workflow_call:/)
  assert.match(rc2, /DSH_VERSION: 0\.2\.0-rc\.2/)
  assert.match(rc2, /name: Windows Desktop Host \/ Node \$\{\{ matrix\.node \}\}/)

})
