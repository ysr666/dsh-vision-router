import type {
  LlmFailure,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

export type LegacyTerminalStreamChunk =
  | Readonly<{ type: 'error'; failure?: unknown }>
  | Readonly<{ type: 'aborted'; failure?: unknown }>

export type VisionStreamChunk = StreamChunk | LegacyTerminalStreamChunk

export interface VisionChunkAssembler {
  push(chunk: VisionStreamChunk): void
  finish(): string
}

interface TextAssemblyPart {
  readonly type: unknown
  text: string
}

type UnknownRecord = Record<PropertyKey, unknown>

function propertyBag(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object'
    ? value as UnknownRecord
    : undefined
}

function failureMessage(failure: unknown): string {
  const message = propertyBag(failure)?.message
  return message ? String(message) : String(failure)
}

/**
 * Minimal DVR text assembler over the public DSH StreamChunk contract.
 *
 * Current DSH failures arrive inside the terminal finish reason. The two
 * standalone terminal shapes remain explicit compatibility input for released
 * historical/partial adapters. Runtime shape checks stay in place because JS
 * callers may still provide malformed chunks.
 */
export function createChunkAssembler(): VisionChunkAssembler {
  const parts = new Map<unknown, TextAssemblyPart>()
  const order: unknown[] = []
  let finishKind: string | undefined
  let failure: unknown

  const pushUnknown = (value: unknown): void => {
    const chunk = propertyBag(value)
    if (chunk === undefined || typeof chunk.type !== 'string') return

    switch (chunk.type) {
      case 'block-start': {
        if (!parts.has(chunk.index)) {
          order.push(chunk.index)
          parts.set(chunk.index, { type: chunk.blockType, text: '' })
        }
        break
      }
      case 'text-delta': {
        const part = parts.get(chunk.index)
        if (part !== undefined) part.text += (chunk.text ?? '') as string
        break
      }
      case 'reasoning-delta':
      case 'tool-call-delta':
      case 'usage':
        break
      case 'block-end': {
        const part = parts.get(chunk.index)
        const block = propertyBag(chunk.block)
        if (part !== undefined && typeof block?.text === 'string') {
          part.text = block.text
        }
        break
      }
      case 'finish': {
        const reason = propertyBag(chunk.reason)
        if (
          reason !== undefined
          && (reason.kind === 'error' || reason.kind === 'aborted')
        ) {
          failure = reason.failure
        }
        finishKind =
          reason !== undefined && reason.kind
            ? String(reason.kind)
            : 'stop'
        break
      }
      case 'error':
      case 'aborted':
        failure = chunk.failure
        break
      default:
        break
    }
  }

  return {
    push(chunk: VisionStreamChunk): void {
      pushUnknown(chunk)
    },

    finish(): string {
      if (failure) throw new Error(failureMessage(failure))
      if (
        finishKind !== undefined
        && finishKind !== 'stop'
        && finishKind !== 'max-tokens'
      ) {
        throw new Error(`vision call finished with "${finishKind}"`)
      }
      return order
        .map((index) => parts.get(index))
        .filter((part): part is TextAssemblyPart =>
          part !== undefined && part.type === 'text')
        .map((part) => part.text)
        .join('')
        .trim()
    },
  }
}

// Compile-time authority checks: the official failure shape remains accepted
// through StreamChunk while legacy standalone failures stay visibly separate.
type OfficialFinish = Extract<StreamChunk, { type: 'finish' }>
type OfficialFailure = Extract<
  OfficialFinish['reason'],
  { kind: 'error' | 'aborted' }
>['failure']

const _officialFailureAuthority: LlmFailure | undefined =
  undefined as OfficialFailure | undefined
void _officialFailureAuthority
