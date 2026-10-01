import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  createChunkAssembler,
  type LegacyTerminalStreamChunk,
  type VisionChunkAssembler,
} from '../../../src/lib/vision-chunk-assembler.js'

const assembler: VisionChunkAssembler = createChunkAssembler()
const official: StreamChunk = {
  type: 'finish',
  reason: { kind: 'max-tokens' },
}
assembler.push(official)

const legacy: LegacyTerminalStreamChunk = {
  type: 'error',
  failure: { message: 'legacy failure' },
}
assembler.push(legacy)

const text: string = assembler.finish()
void text

// @ts-expect-error arbitrary non-DSH chunk shapes are not accepted by typed callers
assembler.push({ type: 'invented-chunk', value: 1 })
