import {
  createSessionVisionAttachmentIndex,
  type SessionVisionAttachmentIndex,
} from '../../../src/lib/session-vision-attachment-index.js'
import {
  createSessionVisionStateStore,
  type SessionVisionAttachmentRef,
} from '../../../src/lib/session-vision-state.js'
import type { SessionLogReader } from '../../../src/lib/session-query-readers.js'

const store = createSessionVisionStateStore()
const readSessionLog: SessionLogReader = async () => ({
  supported: true,
  events: [],
})

const index: SessionVisionAttachmentIndex = createSessionVisionAttachmentIndex({
  stateStore: store,
  collectEventAttachmentRefs: () => [{ attachmentId: 'image-a' }],
  readSessionLog,
})

index.recordAttachments({ id: 'session-a' }, [{ attachmentId: 'image-a' }])

const cached: SessionVisionAttachmentRef | undefined =
  index.lookupAttachment({ id: 'session-a' }, 'image-a')
void cached

const single: Promise<SessionVisionAttachmentRef | undefined> =
  index.resolveAttachment({ id: 'session-a' }, 'image-a')
void single

const batch: Promise<Map<string, SessionVisionAttachmentRef>> =
  index.resolveAttachments({ id: 'session-a' }, ['image-a'])
void batch

// @ts-expect-error batch recovery requires an explicit collection of requested ids
index.resolveAttachments({ id: 'session-a' }, 'image-a')
