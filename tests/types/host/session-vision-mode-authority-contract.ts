import {
  currentSessionVisionModeAuthority,
  resolveSessionVisionModeAuthority,
  runWithSessionVisionModeAuthority,
  type SessionVisionModeAuthority,
} from '../../../src/lib/session-vision-mode-authority.js'

const OWNER = Symbol.for('dsh-vision-router.adapter-owner')
const adapter = { [OWNER]: { route: 'deepseek-vision' } }

const session = {
  selectionState: {
    pending: { provider: 'deepseek-vision', model: 'vision-model' },
  },
  requestHeader() {
    return { config: { provider: 'ordinary', model: 'text-model' } }
  },
}
const agent = { session }
const ctx = {
  llm: {
    registration() {
      return { adapter }
    },
  },
  sessionProjections: {
    stateOf() {
      return session.selectionState
    },
  },
}

const authority: Readonly<SessionVisionModeAuthority> =
  resolveSessionVisionModeAuthority(ctx, agent, {})

const result = runWithSessionVisionModeAuthority(authority, agent, () => {
  const current = currentSessionVisionModeAuthority()
  const reason = current?.reason
  const route = current?.route
  if (route) {
    const provider: string = route.provider
    void provider
    // Step authority carries only route identity, not planner evidence.
    // @ts-expect-error score is not part of the authority route
    route.score
  }
  void reason
  return 'step' as const
})

const literal: 'step' = result
void literal
