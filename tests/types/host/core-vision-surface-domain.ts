import {
  resolveSessionSurfacePolicy,
  type SessionImageOwnership,
  type SessionSurfacePolicy,
} from '../../../src/lib/session-surface-policy-domain.js'
import {
  CORE_VISION_SURFACE_KEYS,
  resolveCoreVisionSurface,
  type CoreVisionSurface,
} from '../../../src/lib/core-vision-surface-domain.js'

const policy: SessionSurfacePolicy = resolveSessionSurfacePolicy({
  visionPolicy: { ownership: 'native-image' },
  visionModeAuthority: { enabled: false },
  config: {
    tool: true,
    rewriteImages: true,
    instantDescribe: true,
  },
})

const surface: CoreVisionSurface = resolveCoreVisionSurface({
  visionPolicy: { ownership: 'vision-router-owned' },
  config: {
    tool: true,
    rewriteImages: true,
    instantDescribe: true,
    autoActivateOnImage: true,
    structuredVisionBootstrap: true,
    proxy: 'must-not-cross-core-boundary',
  },
})

const keys: readonly string[] = CORE_VISION_SURFACE_KEYS
const tool: unknown = surface.values.tool
void policy
void keys
void tool

// @ts-expect-error full plugin Settings are not part of the Core surface
void surface.values.proxy

// @ts-expect-error ownership is a closed DVR domain vocabulary
const invalidOwnership: SessionImageOwnership = 'foreign-image-owner'
void invalidOwnership
