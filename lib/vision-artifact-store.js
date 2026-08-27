import {
  resolveArtifactTarget,
  writeArtifactFile,
} from './artifact-io.js'
import {
  retainArtifactRun,
  scheduleArtifactRetention,
} from './artifact-retention.js'

function live(value) {
  return typeof value === 'function' ? value() : value
}

function callDeps(base, options) {
  const extra = options && typeof options === 'object' ? options.deps : undefined
  return extra && typeof extra === 'object'
    ? { ...base, ...extra }
    : base
}

/**
 * P2 artifact data-plane facade and production ownership boundary.
 *
 * P2-A is intentionally behavior-preserving: this facade owns no new layout,
 * metadata or cleanup policy. It delegates to the hardened artifact IO and
 * retention primitives so paths, filenames, return values, symlink handling,
 * atomic publication, cancellation and run retention remain compatible with
 * the pre-facade runtime. The legacy artifact-boundary module now delegates
 * back into this facade, so old callers and new callers share this one path.
 *
 * `workspace` and `artifactsDir` may be functions so callers can retain the
 * current live-settings/session semantics instead of capturing stale values.
 */
export function createVisionArtifactStore({ workspace, artifactsDir, deps = {} } = {}) {
  const location = () => ({
    workspace: live(workspace),
    artifactsDir: live(artifactsDir),
  })

  const publish = (relativePath, data, options = {}) => {
    const current = location()
    return writeArtifactFile(
      current.workspace,
      current.artifactsDir,
      relativePath,
      data,
      callDeps(deps, options),
    )
  }

  return Object.freeze({
    resolve(relativePath, options = {}) {
      const current = location()
      return resolveArtifactTarget(
        current.workspace,
        current.artifactsDir,
        relativePath,
        callDeps(deps, options),
      )
    },

    publish,

    // P2-A deliberately keeps temporary publication on the existing layout.
    // P2-B may redirect managed run outputs into `.runs/`; doing so here would
    // violate the required first-stage path/filename/return-value parity.
    publishTemporary(relativePath, data, options = {}) {
      return publish(relativePath, data, options)
    },

    retainRun(runId) {
      return retainArtifactRun(runId)
    },

    scheduleRetention(root, options = {}) {
      return scheduleArtifactRetention(root, options)
    },
  })
}
