import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('2.3 critical architecture gate aggregates runtime, Host and package contracts without changing main policy', async () => {
  const [gate, hostContract] = await Promise.all([
    readFile(new URL('../.github/workflows/architecture-2.3-gate.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/dsh-contract.yml', import.meta.url), 'utf8'),
  ])

  assert.match(gate, /name: 2\.3 Critical Architecture Gate/)
  assert.match(gate, /push:\s*\n\s*branches: \[2\.3\.0\]/)
  assert.doesNotMatch(gate, /branches: \[main\]/)
  assert.match(gate, /node: \[22, 24\]/)
  assert.match(gate, /run: pnpm test/)
  assert.match(gate, /tests\/fetch-wrapper-composition\.test\.js/)
  assert.match(gate, /tests\/final-architecture-closure\.test\.js/)
  assert.match(gate, /tests\/security-property-fuzz\.test\.js/)
  assert.match(gate, /uses: \.\/\.github\/workflows\/dsh-contract\.yml/)
  assert.match(gate, /name: critical-gate/)
  assert.match(gate, /needs: \[contracts, current-host-contract\]/)
  assert.match(gate, /test "\$CONTRACTS_RESULT" = success/)
  assert.match(gate, /test "\$HOST_RESULT" = success/)

  assert.match(hostContract, /workflow_call:/)
  assert.match(hostContract, /name: current-contract[\s\S]*?dsh: 0\.1\.5-rc\.3/)
})
