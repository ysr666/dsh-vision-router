import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import {
  isProjectedAttachmentHandle,
  resolveProjectedAttachmentHandle,
  type CompatibleImageAttachmentRef,
} from '../../../src/lib/vision-attachment-handle-runtime.js'

declare const currentRef: ImageAttachmentRef

const index = {
  lookupAttachment(_session: unknown, _id: string): CompatibleImageAttachmentRef | undefined {
    return currentRef
  },
}

const resolution = resolveProjectedAttachmentHandle('sha256:deadbeef', {
  sessionVisionIndex: index,
  agent: {
    session: {
      deriveMessages() {
        return [{ content: [{ type: 'image', attachment: currentRef }] }]
      },
    },
  },
})

if (resolution.kind === 'resolved') {
  const id: string = resolution.canonicalId
  const ref: CompatibleImageAttachmentRef = resolution.ref
  void id
  void ref
}

const projected: boolean = isProjectedAttachmentHandle('sha256:deadbeef')
void projected

const legacyResolution = resolveProjectedAttachmentHandle('sha256:deadbeef', {
  sessionVisionIndex: index,
  agent: {
    inbox: {
      nextTurn: [{ content: [{ type: 'image', attachment: { id: 'sha256:deadbeef00000000' } }] }],
    },
  },
})
void legacyResolution
