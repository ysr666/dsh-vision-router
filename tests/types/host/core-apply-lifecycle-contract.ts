import { runCoreApplyLifecycle } from '../../../src/lib/core-apply-lifecycle.js'

const syncResult = runCoreApplyLifecycle(() => 42)
const syncNumber: number = syncResult
void syncNumber

const asyncResult = runCoreApplyLifecycle(async () => 42)
const asyncNumber: Promise<number> = asyncResult
void asyncNumber

runCoreApplyLifecycle(
  () => 'ok',
  {
    onSuccess() {},
    onFailure(error) {
      void error
    },
  },
)

// Sync callers must not be widened to Promise merely because async callers are supported.
// @ts-expect-error synchronous invoke returns string, not Promise<string>
const wrongSync: Promise<string> = runCoreApplyLifecycle(() => 'ok')
void wrongSync
