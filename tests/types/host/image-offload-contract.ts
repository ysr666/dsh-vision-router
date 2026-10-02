import type { ImageBlock } from '@deepseek-ai/dsh-llm/types'

import {
  blocksHaveRetainedImage,
  isOffloadedImageBlock,
  offloadedImagePlaceholder,
} from '../../../src/lib/image-offload-compat.js'

declare const currentImage: ImageBlock

if (isOffloadedImageBlock(currentImage)) {
  const offloaded: true = currentImage.offloaded
  void offloaded
}

const legacy = {
  type: 'image',
  offloaded: true,
  attachment: { id: 'sha256:deadbeef' },
} as const

if (isOffloadedImageBlock(legacy)) {
  const placeholder: string = offloadedImagePlaceholder(legacy)
  void placeholder
}

const retained: boolean = blocksHaveRetainedImage([currentImage])
void retained
