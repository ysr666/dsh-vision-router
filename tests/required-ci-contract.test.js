import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')

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

test('branch protection requires the real latest Host result on both contract lanes', () => {
  const qualifier = workflow.match(/\n  host_qualification:\n([\s\S]*?)(?=\n  [a-z][a-z_-]*:\n|$)/)?.[1]
  assert.ok(qualifier, 'real Host qualification caller must exist')
  assert.match(qualifier, /uses: \.\/\.github\/workflows\/dsh-022-rc3-host-gate\.yml/)
  assert.doesNotMatch(qualifier, /continue-on-error:|if: false/)
  const contract = workflow.match(/\n  contract:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n|$)/)?.[1]
  assert.ok(contract)
  assert.match(contract, /needs: \[host_qualification\]/)
  assert.match(contract, /if: always\(\)/)
  assert.match(contract, /HOST_ACCEPTANCE_RESULT: \$\{\{ needs\.host_qualification\.result \}\}/)
  assert.match(contract, /if \[ "\$HOST_ACCEPTANCE_RESULT" != success \]; then/)
  assert.match(contract, /exit 1/)
  assert.doesNotMatch(contract, /continue-on-error: true/)
})
