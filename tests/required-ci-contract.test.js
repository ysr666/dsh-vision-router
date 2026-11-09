import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

test('PRs always publish both real branch-protected contract checks', () => {
  assert.match(workflow, /\n  pull_request:\s*\n/, 'PR CI must never be paths-filtered')
  const contract = workflow.match(/\n  contract:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n|$)/)?.[1]
  assert.ok(contract, 'contract job must exist')
  assert.ok(contract.includes('name: contract (${{ matrix.node }})'))
  assert.match(contract, /node:\s*\['24\.9\.0', '24\.21\.0'\]/)
  assert.match(contract, /pnpm install --frozen-lockfile/)
  assert.match(contract, /pnpm typecheck/)
  assert.match(contract, /pnpm lint/)
  assert.match(contract, /node --test tests\/dsh-support-window\.test\.js/)
  assert.doesNotMatch(contract, /if:\s*false|continue-on-error:\s*true/)
})
