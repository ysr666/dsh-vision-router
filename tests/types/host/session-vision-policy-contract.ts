import {
  createSessionVisionPolicyStore,
  delegatedSessionVisionPolicy,
  userSessionVisionPolicy,
  type SessionVisionPolicy,
  type SessionVisionPolicyTable,
} from '../../../src/lib/session-vision-policy.js'

const rows = new Map<string, unknown>()
const table: SessionVisionPolicyTable = {
  get(key) {
    return rows.get(key)
  },
  async put(key, value) {
    rows.set(key, value)
  },
  async delete(key) {
    rows.delete(key)
  },
}

const store = createSessionVisionPolicyStore(table)
const user: Readonly<SessionVisionPolicy> = userSessionVisionPolicy(true)
const delegated: Readonly<SessionVisionPolicy> = delegatedSessionVisionPolicy(
  user.enabled,
  'parent-session',
)

void store.set('child-session', delegated)
const current = store.get('child-session')
if (current?.source === 'delegation') {
  const parent: string = current.inheritedFrom
  void parent
}

// Policy deliberately carries intent only. Provider/model remain route-owner data.
// @ts-expect-error provider is not part of Session Vision policy
user.provider
// @ts-expect-error model is not part of Session Vision policy
delegated.model
