import { createVisionArtifactStore } from './vision-artifact-store.js'

export {
  DEFAULT_ARTIFACTS_DIR,
  normalizeArtifactsDir,
} from './artifact-io.js'

/**
 * Compatibility boundary retained for existing production callers during P2.
 * Resolution authority now flows through VisionArtifactStore while the public
 * function signature and return value remain unchanged.
 */
export function resolveArtifactTarget(workspace, artifactsDir, relativePath, deps = {}) {
  return createVisionArtifactStore({ workspace, artifactsDir, deps }).resolve(relativePath)
}

/**
 * Compatibility writer retained while callers migrate to VisionArtifactStore.
 * The store delegates to the exact hardened IO primitive that previously lived
 * here, so path layout, atomic publication, cancellation and retention semantics
 * remain unchanged.
 */
export function writeArtifactFile(workspace, artifactsDir, relativePath, data, deps = {}) {
  return createVisionArtifactStore({ workspace, artifactsDir, deps }).publish(relativePath, data)
}
