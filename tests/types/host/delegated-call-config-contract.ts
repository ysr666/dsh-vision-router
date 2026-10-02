import type { GenerateOptions } from '@deepseek-ai/dsh-llm/types'

import { projectDelegatedCallConfig } from '../../../src/lib/delegated-call-config.js'

declare const call: GenerateOptions & { readonly dvrTraceId: string }

const projected = projectDelegatedCallConfig(call)

const provider: string = projected.provider
const traceId: string = projected.dvrTraceId
void provider
void traceId

// Delegation must not preserve source-route policy knobs.
// @ts-expect-error reasoningEffort belongs to the source route and is stripped
projected.reasoningEffort
// @ts-expect-error temperature belongs to the source route and is stripped
projected.temperature
// @ts-expect-error maxTokens belongs to the source route and is stripped
projected.maxTokens
// @ts-expect-error stop belongs to the source route and is stripped
projected.stop

const primitive = projectDelegatedCallConfig('unchanged')
const unchanged: string = primitive
void unchanged
