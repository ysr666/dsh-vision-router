// The drift canaries are the only gates that follow upstream without a pinned version,
// so they must not pin anything about the Host they meet. `dsh-alpha-canary` once
// inherited the `native-register` settings default — correct for the 0.1.5 train and
// wrong for every 0.2.x Host — and reported "unsupported" for a release family DVR
// supports, while `dsh-latest-canary` stayed green on the same version. These assertions
// keep the repair in place: the floating gates derive the settings seam from the Host,
// resolve their version from the registry, and report every contract they run.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const CANARIES = ['dsh-alpha-canary.yml', 'dsh-latest-canary.yml']

async function readWorkflow(name) {
  return readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')
}

test('floating canaries derive the settings seam instead of pinning one shape', async () => {
  for (const name of CANARIES) {
    const workflow = await readWorkflow(name)
    // A canary may name the mode inline or hand a matrix value to the smoke; either way
    // every effective mode must be `auto`, because the seam belongs to the Host.
    const inline = [...workflow.matchAll(/EXPECT_SETTINGS_MODE:\s*(\S+)/g)]
      .map((m) => m[1])
      .filter((value) => !value.startsWith('${{'))
    const matrixValues = [...workflow.matchAll(/settings_mode:\s*(\S+)/g)].map((m) => m[1])
    const effective = [...new Set([...inline, ...matrixValues])]
    assert.ok(effective.length > 0, `${name} must declare an effective settings mode`)
    assert.deepEqual(effective, ['auto'], `${name} must let the Host decide the settings seam`)
    if (/EXPECT_SETTINGS_MODE: \$\{\{ matrix\.settings_mode \}\}/.test(workflow)) {
      assert.ok(matrixValues.length > 0, `${name} must define matrix.settings_mode`)
    }
    // A seam pinned here goes stale on the next upstream settings change: that is how
    // the alpha canary reported a supported Host as unsupported.
    assert.doesNotMatch(workflow, /EXPECT_SETTINGS_MODE: (native-register|config-editor)/)
  }
})

test('floating canaries resolve the release from the registry, not from a pinned version', async () => {
  for (const name of CANARIES) {
    const workflow = await readWorkflow(name)
    assert.match(workflow, /dist-tags\./, `${name} must follow the published dist-tags`)
  }
})

test('the alpha canary reports every contract instead of stopping at the first failure', async () => {
  const workflow = await readWorkflow('dsh-alpha-canary.yml')
  for (const id of ['alpha-host-capability', 'alpha-pi-ai-wire', 'alpha-native-lifecycle']) {
    assert.match(workflow, new RegExp(`id: ${id}\\n\\s+continue-on-error: true`), `${id} must not mask later contracts`)
  }
  assert.match(workflow, /name: Require every alpha contract\n\s+if: always\(\)/)
  assert.match(workflow, /alpha contracts failed/)
})
