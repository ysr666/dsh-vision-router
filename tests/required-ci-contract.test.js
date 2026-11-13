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

test('branch protection requires trusted impact and all three real Host results', () => {
  assert.match(workflow, /\n  host_impact:\n/)
  assert.match(workflow, /git show "\$BASE_SHA:scripts\/ci-heavy-host-impact\.mjs"/)
  assert.match(workflow, /git diff --name-only "\$BASE_SHA" "\$HEAD_SHA"/)
  for (const [name, target] of [
    ['floor_qualification', 'dsh-021-rc5-validation.yml'],
    ['recommended_qualification', 'dsh-022-rc1-host-gate.yml'],
    ['host_qualification', 'dsh-022-rc3-host-gate.yml'],
  ]) {
    const job = workflow.split('\n  ' + name + ':\n')[1]?.split(/\n  [a-z][a-z_-]*:\n/)[0]
    assert.ok(job, name + ' must be a real called workflow')
    assert.match(job, /needs: host_impact/)
    assert.match(job, /if: needs\.host_impact\.outputs\.heavy == 'true'/)
    assert.ok(job.includes('uses: ./.github/workflows/' + target))
    assert.doesNotMatch(job, /continue-on-error:/)
  }
  const contract = workflow.match(/\n  contract:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n|$)/)?.[1]
  assert.ok(contract)
  assert.match(contract, /needs: \[host_impact, floor_qualification, recommended_qualification, host_qualification\]/)
  assert.match(contract, /if: always\(\)/)
  assert.match(contract, /CLASSIFIER_RESULT: \$\{\{ needs\.host_impact\.result \}\}/)
  assert.match(contract, /HOST_IMPACT: \$\{\{ needs\.host_impact\.outputs\.heavy \}\}/)
  for (const key of ['FLOOR_RESULT', 'RECOMMENDED_RESULT', 'LATEST_RESULT']) {
    assert.ok(contract.includes(key + ': ${{ needs.'), 'missing real required Host result: ' + key)
  }
  assert.match(contract, /if \[ "\$CLASSIFIER_RESULT" != success \]; then/)
  assert.match(contract, /if \[ "\$HOST_IMPACT" = true \]; then/)
  assert.match(contract, /if \[ "\$HOST_IMPACT" = false \]; then/)
  assert.match(contract, /if \[ "\$result" != success \]; then/)
  assert.match(contract, /if \[ "\$result" != skipped \]; then/)
  assert.match(contract, /Invalid trusted impact verdict/)
  assert.doesNotMatch(contract, /continue-on-error: true/)
})
