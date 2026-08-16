from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    assert count == 1, f'{label}: expected one match, got {count}'
    return text.replace(old, new, 1)


p = Path('lib/client.js')
s = p.read_text()

# A dismissal/finish must win for this page even if the Host cannot persist
# hidden walkthrough state yet. Otherwise stale settings resurrect the guide.
s = replace_once(
    s,
    "    let visionGuideSyncTimer\n    let visionGuideStepMemory\n    // Installed by apply(): a narrow, defensive view of the settings scope.\n",
    "    let visionGuideSyncTimer\n    let onboardingSeenMemory = false\n    let visionGuideStepMemory\n    let visionGuideMemoryAuthoritative = false\n    // Installed by apply(): a narrow, defensive view of the settings scope.\n",
    'guide memory declarations',
)

# Hidden UI-state writes used to be fire-and-forget. Queue one latest intent per
# field, flush when the settings scope is ready, verify raw-user readback, and
# never spin forever when an older Host rejects the new hidden field.
start = s.index('    function installSettingsPersistence(scope) {')
end = s.index('\n\n    function readOnboardingSeen() {', start)
new_persistence = '''    function installSettingsPersistence(scope) {
      const pending = new Map()
      let flushing = false
      const readSnapshot = () => {
        try {
          return scope && typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : undefined
        } catch {
          return undefined
        }
      }
      const readSection = () => {
        const snapshot = readSnapshot()
        return snapshot && snapshot.value ? snapshot.value : undefined
      }
      const queue = (field, operation, value) => {
        const previous = pending.get(field)
        if (
          previous && previous.operation === operation &&
          (operation === 'unset' || jsonValueEqual(previous.value, value))
        ) {
          return
        }
        pending.set(field, { operation, value, attempted: false })
        void flush()
      }
      const landed = (field, entry) => {
        const snapshot = readSnapshot()
        const user = snapshot && snapshot.user
        const stored = !!user && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, field)
        return entry.operation === 'unset'
          ? !stored
          : stored && jsonValueEqual(user[field], entry.value)
      }
      const flush = async () => {
        if (flushing) return
        const snapshot = readSnapshot()
        if (!snapshot || snapshot.status !== 'ready' || !snapshot.writable) return
        const work = [...pending.entries()].filter(([, entry]) => !entry.attempted)
        if (work.length === 0) return
        flushing = true
        try {
          for (const [field, entry] of work) {
            if (pending.get(field) !== entry) continue
            entry.attempted = true
            try {
              if (entry.operation === 'unset') {
                if (typeof scope.unset !== 'function') continue
                await scope.unset(field)
              } else {
                if (typeof scope.set !== 'function') continue
                await scope.set(field, entry.value)
              }
            } catch {
              continue
            }
            if (pending.get(field) === entry && landed(field, entry)) pending.delete(field)
          }
        } finally {
          flushing = false
        }
      }
      settingsPersistence = {
        get(field) {
          const section = readSection()
          return section ? section[field] : undefined
        },
        set(field, value) {
          queue(field, 'set', value)
        },
        unset(field) {
          queue(field, 'unset')
        },
        subscribe(listener) {
          try {
            if (!scope || typeof scope.subscribe !== 'function') return undefined
            return scope.subscribe(() => {
              void flush()
              listener()
            })
          } catch {
            return undefined
          }
        },
      }
      void flush()
    }'''
s = s[:start] + new_persistence + s[end:]

s = replace_once(
    s,
    "    function readOnboardingSeen() {\n      try {\n",
    "    function readOnboardingSeen() {\n      if (onboardingSeenMemory) return true\n      try {\n",
    'onboarding memory read',
)
s = replace_once(
    s,
    "    function rememberOnboardingSeen() {\n      try {\n",
    "    function rememberOnboardingSeen() {\n      onboardingSeenMemory = true\n      try {\n",
    'onboarding memory write',
)
s = replace_once(
    s,
    "    function readVisionGuideStep() {\n      try {\n",
    "    function readVisionGuideStep() {\n      if (visionGuideMemoryAuthoritative) return visionGuideStepMemory\n      try {\n",
    'guide authoritative read',
)
s = replace_once(
    s,
    "    function writeVisionGuideStep(step) {\n      visionGuideStepMemory = step === 'step1' || step === 'step2' ? step : undefined\n",
    "    function writeVisionGuideStep(step) {\n      visionGuideMemoryAuthoritative = true\n      visionGuideStepMemory = step === 'step1' || step === 'step2' ? step : undefined\n",
    'guide authoritative write',
)

# Old documents can contain empty rows. They should not render as several blank
# selectors. Fully empty rows are junk; half-filled rows remain visible/invalid.
marker = "    function providersToText(value) {\n"
helper = '''    function normalizeVisionChainRows(value) {
      if (!Array.isArray(value)) return []
      const rows = []
      for (const row of value) {
        if (!row || typeof row !== 'object') continue
        const provider = typeof row.provider === 'string' ? row.provider.trim() : ''
        const model = typeof row.model === 'string' ? row.model.trim() : ''
        if (provider === 'vision-http' || (provider === '' && model === '')) continue
        rows.push({ ...row, provider, model })
      }
      return rows
    }

'''
assert s.count(marker) == 1
s = s.replace(marker, helper + marker, 1)
s = replace_once(
    s,
    "          if (catalogReady) return Array.isArray(value) ? value.filter((row) => row && row.provider !== 'vision-http') : []\n",
    "          if (catalogReady) return normalizeVisionChainRows(value)\n",
    'provider display normalization',
)
s = replace_once(
    s,
    "            const rows = Array.isArray(text) ? text : []\n            const half = rows.some((row) => row && (row.provider ? !row.model : !!row.model))\n",
    "            const rows = normalizeVisionChainRows(text)\n            const half = rows.some((row) => row && (row.provider ? !row.model : !!row.model))\n",
    'provider parse normalization',
)

# Keep PR #102's readback verification, but one transient stale/rejected view
# should not strand the form forever. Refresh once and retry the idempotent op.
commit_start = s.index('    async function commitSettingsPlan(scope, plan, drafts = {}) {')
commit_end = s.index('\n\n    function reportSettingsSaveFailures', commit_start)
new_commit = '''    async function commitSettingsPlan(scope, plan, drafts = {}) {
      const failures = []
      const landedFields = []
      const inspectReadback = (item) => {
        let snapshot
        try {
          snapshot = scope.getSnapshot()
        } catch (error) {
          return { error: {
            field: item.key,
            operation: item.run.clear ? 'unset' : 'set',
            reason: 'readback-error',
            detail: settingsSaveErrorMessage(error),
          } }
        }
        const user = snapshot && snapshot.user
        const stored = !!user && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, item.key)
        const ok = item.run.clear
          ? !stored
          : stored && jsonValueEqual(user[item.key], item.run.value)
        return { ok, stored }
      }
      const writeItem = async (item) => {
        if (item.run.clear) await scope.unset(item.key)
        else await scope.set(item.key, item.run.value)
      }
      for (const item of plan) {
        const operation = item.run.clear ? 'unset' : 'set'
        let success = false
        let terminalFailure
        for (let attempt = 0; attempt < 2 && !success; attempt++) {
          try {
            await writeItem(item)
          } catch (error) {
            terminalFailure = {
              field: item.key,
              operation,
              reason: 'write-error',
              detail: settingsSaveErrorMessage(error),
            }
            break
          }

          let check = inspectReadback(item)
          if (check.error) {
            terminalFailure = check.error
            break
          }
          if (check.ok) {
            success = true
            break
          }

          if (attempt === 0 && typeof scope.load === 'function') {
            try {
              await scope.load()
            } catch {
              // The idempotent retry below is still safe.
            }
            check = inspectReadback(item)
            if (check.error) {
              terminalFailure = check.error
              break
            }
            if (check.ok) {
              success = true
              break
            }
          }

          terminalFailure = {
            field: item.key,
            operation,
            reason: 'readback-mismatch',
            detail: item.run.clear
              ? 'field remained present in the user layer'
              : check.stored
                ? 'stored user-layer value differs from the requested value'
                : 'field is absent from the user layer',
          }
        }
        if (success) landedFields.push(item.key)
        else failures.push(terminalFailure ?? {
          field: item.key,
          operation,
          reason: 'readback-mismatch',
          detail: 'write did not become visible in the user layer',
        })
      }
      const landed = failures.length === 0
      const nextDrafts = landedFields.length === 0 ? drafts : { ...drafts }
      for (const field of landedFields) delete nextDrafts[field]
      return {
        landed,
        failed: !landed,
        landedFields,
        nextDrafts,
        failures,
      }
    }'''
s = s[:commit_start] + new_commit + s[commit_end:]

# Make the visible error actionable by naming the field(s) that actually failed.
s = replace_once(
    s,
    "      const [failed, setFailed] = useState(false)\n",
    "      const [failed, setFailed] = useState(false)\n      const [failedFields, setFailedFields] = useState([])\n",
    'failed field state',
)
s = replace_once(
    s,
    "      const setDraft = (key, text) => {\n        setFailed(false)\n        setDrafts((prev) => ({ ...prev, [key]: text }))\n",
    "      const setDraft = (key, text) => {\n        setFailed(false)\n        setFailedFields([])\n        setDrafts((prev) => ({ ...prev, [key]: text }))\n",
    'clear failed fields on edit',
)
s = replace_once(
    s,
    "      const clearDrafts = () => {\n        setDrafts({})\n        setFailed(false)\n",
    "      const clearDrafts = () => {\n        setDrafts({})\n        setFailed(false)\n        setFailedFields([])\n",
    'clear failed fields on discard',
)
s = replace_once(
    s,
    "        setSaving(true)\n        setFailed(false)\n        try {\n          const outcome = await commitSettingsPlan(scope, plan, drafts)\n",
    "        setSaving(true)\n        setFailed(false)\n        setFailedFields([])\n        try {\n          const outcome = await commitSettingsPlan(scope, plan, drafts)\n",
    'clear failed fields before save',
)
s = replace_once(
    s,
    "          if (outcome.failed) reportSettingsSaveFailures(outcome.failures)\n          setFailed(outcome.failed)\n",
    "          if (outcome.failed) reportSettingsSaveFailures(outcome.failures)\n          setFailed(outcome.failed)\n          setFailedFields(outcome.failed ? [...new Set(outcome.failures.map((failure) => failure.field))] : [])\n",
    'capture failed fields',
)
s = replace_once(
    s,
    "          reportSettingsSaveFailures([{\n            field: 'settings-plan',\n            operation: 'set',\n            reason: 'write-error',\n            detail: settingsSaveErrorMessage(error),\n          }])\n          setFailed(true)\n        } finally {\n",
    "          reportSettingsSaveFailures([{\n            field: 'settings-plan',\n            operation: 'set',\n            reason: 'write-error',\n            detail: settingsSaveErrorMessage(error),\n          }])\n          setFailed(true)\n          setFailedFields(['settings-plan'])\n        } finally {\n",
    'capture save exception field',
)
s = replace_once(
    s,
    "      const resetField = async (key) => {\n        if (editBlocked) return\n        setFailed(false)\n        setSaving(true)\n",
    "      const resetField = async (key) => {\n        if (editBlocked) return\n        setFailed(false)\n        setFailedFields([])\n        setSaving(true)\n",
    'clear failed fields before reset',
)
s = replace_once(
    s,
    "          if (!outcome.landed) {\n            reportSettingsSaveFailures(outcome.failures)\n            setFailed(true)\n            return\n          }\n",
    "          if (!outcome.landed) {\n            reportSettingsSaveFailures(outcome.failures)\n            setFailed(true)\n            setFailedFields([...new Set(outcome.failures.map((failure) => failure.field))])\n            return\n          }\n",
    'capture reset verification fields',
)
s = replace_once(
    s,
    "          reportSettingsSaveFailures([{\n            field: key,\n            operation: 'unset',\n            reason: 'write-error',\n            detail: settingsSaveErrorMessage(error),\n          }])\n          setFailed(true)\n        } finally {\n",
    "          reportSettingsSaveFailures([{\n            field: key,\n            operation: 'unset',\n            reason: 'write-error',\n            detail: settingsSaveErrorMessage(error),\n          }])\n          setFailed(true)\n          setFailedFields([key])\n        } finally {\n",
    'capture reset exception field',
)
s = replace_once(
    s,
    "                failed ? h('p', { className: 'vr-failed', role: 'alert' }, t('saveFailed')) : null,\n",
    "                failed ? h('p', { className: 'vr-failed', role: 'alert' },\n                  t('saveFailed') + (failedFields.length > 0 ? `（${failedFields.join('、')}）` : '')) : null,\n",
    'render failed fields',
)
s = replace_once(
    s,
    "    exports.collectFilteredVisionBackends = collectFilteredVisionBackends\n    exports.jsonValueEqual = jsonValueEqual\n",
    "    exports.collectFilteredVisionBackends = collectFilteredVisionBackends\n    exports.normalizeVisionChainRows = normalizeVisionChainRows\n    exports.jsonValueEqual = jsonValueEqual\n",
    'normalizer export',
)
p.write_text(s)


t = Path('tests/client.test.js')
ts = t.read_text()
ts = replace_once(
    ts,
    "  assert.deepEqual(calls, [['providers', requested]])\n",
    "  assert.deepEqual(calls, [['providers', requested], ['providers', requested]])\n",
    'retry call expectation',
)

insertion = '''

test('commitSettingsPlan retries one resolved-but-unlanded settings write', async () => {
  const bundle = loadClientBundle()
  const requested = [{ provider: 'zhipu', model: 'glm-4.6v-flash' }]
  const snapshot = { status: 'ready', writable: true, user: {} }
  let writes = 0
  let loads = 0
  const outcome = await bundle.commitSettingsPlan({
    async set(field, value) {
      writes += 1
      if (writes === 2) snapshot.user[field] = structuredClone(value)
    },
    async load() { loads += 1 },
    getSnapshot() { return snapshot },
  }, [{ key: 'providers', run: { value: requested } }], { providers: requested })

  assert.equal(outcome.landed, true)
  assert.equal(writes, 2)
  assert.equal(loads, 1)
  assert.deepEqual(outcome.nextDrafts, {})
})

test('vision chain normalization drops legacy blank rows without hiding half-filled drafts', () => {
  const bundle = loadClientBundle()
  assert.deepEqual(bundle.normalizeVisionChainRows([
    { provider: '', model: '' },
    { provider: '  ', model: ' ' },
    { provider: 'vision-http', model: 'ovh/Qwen3.5-397B-A17B' },
    { provider: ' zhipu ', model: '' },
    { provider: ' siliconflow ', model: ' Qwen/Qwen3-VL-32B-Instruct ' },
  ]), [
    { provider: 'zhipu', model: '' },
    { provider: 'siliconflow', model: 'Qwen/Qwen3-VL-32B-Instruct' },
  ])
})

test('guide dismissal is page-authoritative and hidden persistence does not spin on rejection', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(source.includes('let onboardingSeenMemory = false'), true)
  assert.equal(source.includes('if (onboardingSeenMemory) return true'), true)
  assert.equal(source.includes('onboardingSeenMemory = true'), true)
  assert.equal(source.includes('let visionGuideMemoryAuthoritative = false'), true)
  assert.equal(source.includes('if (visionGuideMemoryAuthoritative) return visionGuideStepMemory'), true)
  assert.equal(source.includes('visionGuideMemoryAuthoritative = true'), true)
  assert.equal(source.includes("pending.set(field, { operation, value, attempted: false })"), true)
  assert.equal(source.includes('filter(([, entry]) => !entry.attempted)'), true)
})
'''
marker_test = "\ntest('settings save failure copy says unwritten drafts were kept', () => {\n"
assert ts.count(marker_test) == 1
ts = ts.replace(marker_test, insertion + marker_test, 1)
old_assert = "  assert.equal(source.includes(\"className: 'vr-failed', role: 'alert'\"), true)\n"
assert ts.count(old_assert) == 1
ts = ts.replace(old_assert, old_assert + "  assert.equal(source.includes(\"failedFields.join('、')\"), true)\n", 1)
t.write_text(ts)
