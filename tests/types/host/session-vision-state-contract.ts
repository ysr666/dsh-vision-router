import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import {
  createSessionVisionStateStore,
  type SessionVisionAttachmentRef,
  type SessionVisionStoreStats,
} from '../../../src/lib/session-vision-state.js'

const store = createSessionVisionStateStore({ maxSessions: 8 })
const session = { id: 'session-a' }

store.recordAttachments(session, [
  { attachmentId: 'legacy', name: 'legacy.png' },
])

declare const currentRef: ImageAttachmentRef
store.recordAttachments(session, [currentRef])

const legacy: SessionVisionAttachmentRef | undefined =
  store.lookupAttachment(session, 'legacy')
const current: SessionVisionAttachmentRef | undefined =
  store.lookupAttachment(session, currentRef.attachmentId)

const memory = store.memoryForSession(session)
memory.set('legacy', { structured: true })
const description: unknown = memory.get('legacy')
const stats: SessionVisionStoreStats = store.stats()

void legacy
void current
void description
void stats
