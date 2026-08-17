from pathlib import Path


def replace_once(text, old, new, label):
    if old not in text:
        raise SystemExit(f'missing anchor: {label}')
    return text.replace(old, new, 1)

p = Path('lib/client.js')
s = p.read_text()

s = replace_once(s, """    function installSettingsPersistence(scope) {
      const pending = new Map()
      let flushing = false
""", """    function installSettingsPersistence(scope) {
      const pending = new Map()
      // Browser-side hidden settings (onboardingSeen / visionGuideStep) are
      // best-effort durability hints, not a retry queue. Remember the last
      // mutation issued for each field for this page lifetime so a rejected
      // Host write or a stale/oscillating snapshot can never create an
      // endless /api/settings.mutate loop (issue #155).
      const issued = new Map()
      let flushing = false
""", 'issued map')

s = replace_once(s, """      const queue = (field, operation, value) => {
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
""", """      const sameMutation = (left, operation, value) =>
        !!left && left.operation === operation &&
        (operation === 'unset' || jsonValueEqual(left.value, value))
      const alreadyStored = (field, operation, value) => {
        const snapshot = readSnapshot()
        const user = snapshot && snapshot.user
        const stored = !!user && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, field)
        return operation === 'unset'
          ? !stored
          : stored && jsonValueEqual(user[field], value)
      }
      const queue = (field, operation, value) => {
        // No network mutation when the raw user layer already has the exact
        // requested state. This also makes repeated finish/dismiss handlers
        // idempotent after a successful write.
        if (alreadyStored(field, operation, value)) {
          pending.delete(field)
          issued.set(field, { operation, value })
          return
        }
        const previous = pending.get(field)
        if (sameMutation(previous, operation, value)) return
        // Once an identical hidden-state mutation was attempted in this page,
        // never auto-retry it merely because subscribe/readback fired again.
        // A genuinely different value/operation is still allowed through.
        if (sameMutation(issued.get(field), operation, value)) return
        pending.set(field, { operation, value, attempted: false })
        void flush()
      }
""", 'queue dedupe')

s = replace_once(s, """            if (pending.get(field) !== entry) continue
            entry.attempted = true
            try {
""", """            if (pending.get(field) !== entry) continue
            entry.attempted = true
            issued.set(field, { operation: entry.operation, value: entry.value })
            try {
""", 'mark issued')

s = replace_once(s, """        } finally {
          flushing = false
        }
      }
""", """        } finally {
          flushing = false
          // A different value may have been queued while the previous write
          // was in flight. Drain it once; identical mutations were filtered by
          // `issued`, so this cannot become a subscribe-driven busy loop.
          if ([...pending.values()].some((entry) => !entry.attempted)) void flush()
        }
      }
""", 'drain queued mutation')

s = replace_once(s, """      void flush()
    }

    function readOnboardingSeen() {
""", """      void flush()
      return settingsPersistence
    }

    function readOnboardingSeen() {
""", 'return persistence')

s = replace_once(s, """    exports.commitSettingsPlan = commitSettingsPlan
    return module.exports
""", """    exports.commitSettingsPlan = commitSettingsPlan
    exports.installSettingsPersistence = installSettingsPersistence
    return module.exports
""", 'export persistence')
p.write_text(s)

p = Path('tests/client.test.js')
s = p.read_text()
if 'hidden settings persistence sends an identical mutation at most once' not in s:
    s += r'''

test('hidden settings persistence sends an identical mutation at most once (issue #155)', async () => {
  const bundle = loadClientBundle()
  const snapshot = { status: 'ready', writable: true, value: {}, user: {} }
  const listeners = new Set()
  let writes = 0
  const scope = {
    getSnapshot() { return snapshot },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async set() {
      writes += 1
      // Reproduce the problematic Host behavior: resolve/recover without
      // landing the value, while subscribers keep receiving snapshots.
      for (const listener of [...listeners]) listener()
    },
    async unset() {
      writes += 1
      for (const listener of [...listeners]) listener()
    },
  }
  const persistence = bundle.installSettingsPersistence(scope)
  persistence.subscribe(() => {
    // A render/effect can ask for the same hidden state again on every
    // snapshot. It must not generate another settings.mutate request.
    persistence.set('onboardingSeen', true)
  })
  persistence.set('onboardingSeen', true)
  for (let i = 0; i < 8; i++) {
    for (const listener of [...listeners]) listener()
    persistence.set('onboardingSeen', true)
    await Promise.resolve()
  }
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(writes, 1)
})

test('hidden settings persistence skips mutations already present in the user layer', async () => {
  const bundle = loadClientBundle()
  const snapshot = {
    status: 'ready', writable: true,
    value: { onboardingSeen: true },
    user: { onboardingSeen: true },
  }
  let writes = 0
  const persistence = bundle.installSettingsPersistence({
    getSnapshot() { return snapshot },
    subscribe() { return () => {} },
    async set() { writes += 1 },
    async unset() { writes += 1 },
  })
  persistence.set('onboardingSeen', true)
  await Promise.resolve()
  assert.equal(writes, 0)
})

test('hidden settings persistence still permits real state transitions', async () => {
  const bundle = loadClientBundle()
  const snapshot = { status: 'ready', writable: true, value: {}, user: {} }
  const writes = []
  const persistence = bundle.installSettingsPersistence({
    getSnapshot() { return snapshot },
    subscribe() { return () => {} },
    async set(field, value) { writes.push(['set', field, value]); snapshot.user[field] = value; snapshot.value[field] = value },
    async unset(field) { writes.push(['unset', field]); delete snapshot.user[field]; delete snapshot.value[field] },
  })
  persistence.set('visionGuideStep', 'step1')
  await new Promise((resolve) => setTimeout(resolve, 0))
  persistence.set('visionGuideStep', 'step2')
  await new Promise((resolve) => setTimeout(resolve, 0))
  persistence.unset('visionGuideStep')
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(writes, [
    ['set', 'visionGuideStep', 'step1'],
    ['set', 'visionGuideStep', 'step2'],
    ['unset', 'visionGuideStep'],
  ])
})
'''
p.write_text(s)
