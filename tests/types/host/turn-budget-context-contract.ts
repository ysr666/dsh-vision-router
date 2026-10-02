import {
  currentVisionTurnBudget,
  currentVisionTurnBudgetSignal,
  remainingVisionTurnBudgetMs,
  runWithVisionTurnBudget,
  type VisionTurnBudget,
} from '../../../src/lib/turn-budget-context.js'

const controller = new AbortController()

const result = runWithVisionTurnBudget(
  {
    signal: controller.signal,
    deadlineAt: Date.now() + 1000,
    artifactRunId: '.vision-run-example',
    callerOwnedMetadata: { retained: true },
  },
  () => {
    const budget: VisionTurnBudget | undefined = currentVisionTurnBudget()
    const signal: AbortSignal | undefined = currentVisionTurnBudgetSignal()
    const remaining: number | undefined = remainingVisionTurnBudgetMs()

    const metadata: unknown = budget?.callerOwnedMetadata
    void signal
    void remaining
    void metadata
    return 42 as const
  },
)

const literal: 42 = result
void literal
