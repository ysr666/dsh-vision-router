import {
  currentVisionExecutionOrder,
  withVisionExecutionOrder,
  type VisionRouteIdentity,
} from '../../../src/lib/vision-execution-order.js'
import {
  applyVisionExecutionOrder,
} from '../../../src/lib/vision-execution-order-apply.js'

const base = [
  { provider: 'a', model: 'm1', score: 0.4 },
  { provider: 'b', model: 'm2', score: 0.9 },
] as const

const scoped: readonly VisionRouteIdentity[] = [
  { provider: 'b', model: 'm2' },
  { provider: 'a', model: 'm1' },
]

const reordered = applyVisionExecutionOrder(base, scoped)
const retainedScore: 0.9 | 0.4 = reordered[0]!.score
void retainedScore

const result = withVisionExecutionOrder(
  [{ provider: 'a', model: 'm1', score: 999, settings: { unsafe: true } }],
  () => {
    const current = currentVisionExecutionOrder()
    const pair = current?.[0]
    if (pair) {
      const provider: string = pair.provider
      void provider

      // The async scope owns detached route identity only.
      // @ts-expect-error planner score must not leak into execution scope
      pair.score
      // @ts-expect-error Settings snapshots must not leak into execution scope
      pair.settings
    }
    return 'done' as const
  },
)

const literalResult: 'done' = result
void literalResult
