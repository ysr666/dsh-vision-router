// #865 B2: narrow read-only wire contract. Never serialize an Agent, adapter,
// policy backing row, credential, inherited parent ID or arbitrary error.
import { z } from 'zod'

const selection = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
})

export const nativeVisionControlViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('native'),
    selection,
    enabled: z.boolean(),
    requestedEnabled: z.boolean(),
    canEnable: z.boolean(),
    durable: z.boolean().nullable(),
  }),
  z.strictObject({
    kind: z.literal('legacy'),
    reason: z.enum(['dvr-wrapper', 'text-only']),
    selection,
  }),
  z.strictObject({
    kind: z.literal('unavailable'),
    reason: z.enum([
      'inactive-session', 'no-selection', 'no-registration',
      'metadata-unavailable', 'stale-selection', 'policy-store-unavailable',
      'policy-read-failed', 'observer-unavailable',
    ]),
  }),
])

export const nativeVisionControlSessionIdSchema = z.string().min(1)
