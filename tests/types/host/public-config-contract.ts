import z from '@deepseek-ai/schemastery'

import {
  composePublicVisionConfig,
  SETTINGS_CONTRACT_REVISION,
} from '../../../src/lib/public-config.js'

const core = z.object({
  provider: z.string().default('vision-http'),
})

const composed = composePublicVisionConfig(core)
const sameIdentityType: typeof core = composed
const revision: 7 = SETTINGS_CONTRACT_REVISION

void sameIdentityType
void revision
