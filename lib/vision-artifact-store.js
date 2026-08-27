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
 * Managed tool-run artifacts are isolated by the hardened IO layer under
 * `<artifactsDir>/.runs/<runId>/...`. Calls made without a managed run keep the
 * historical `<artifactsDir>/<relativePath>` layout, so persistent/user-facing
 * artifacts do not move merely because the Store exists.
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

    // Temporary-vs-persistent placement is authority/lifetime driven: the
    // ambient managed artifactRunId decides whether hardened IO uses `.runs`.
    // Keeping this method as an alias avoids inventing a second placement path.
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
