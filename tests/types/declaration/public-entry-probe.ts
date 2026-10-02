/**
 * Declaration-semantics probe for the published root entry.
 *
 * `pnpm typecheck` checks the source graph with `skipLibCheck: true`, and the
 * packed-consumer program only runs when a tarball is passed. This program
 * type-checks the generated `lib/public-entry.d.ts` under
 * `skipLibCheck: false`, so a semantic error inside the published declaration
 * fails the normal typecheck gate.
 */
import * as dvr from '../../../lib/public-entry.js'
import type { SessionSurfaceReplacementIntent } from '../../../lib/public-entry.js'

const exactName: 'vision-router' = dvr.name
const exactRevision: 7 = dvr.SETTINGS_CONTRACT_REVISION
const exactInject: readonly ['tools', 'llm'] = dvr.inject

const config: Record<string, unknown> = dvr.Config({})
const applied: unknown = dvr.apply({ effect: () => () => {} }, config)

const intent: SessionSurfaceReplacementIntent | undefined =
  dvr.sessionSurfaceReplacementIntent({ header: { version: 4 } }, 1)

// A lifecycle-less context is rejected by the declaration, matching runtime.
// @ts-expect-error apply() requires a CordisLifecycleContext
dvr.apply({}, config)

// @ts-expect-error the root entry does not expose provider transport injection
dvr.apply({ effect: () => () => {} }, config, { providerTransport: {} })

// @ts-expect-error Session surface replacement requires an explicit sequence
dvr.sessionSurfaceReplacementIntent({ header: { version: 4 } })

void exactName
void exactRevision
void exactInject
void applied
void intent
