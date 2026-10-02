/**
 * Browser-side product maintenance actions, independent of React rendering.
 *
 * State access is supplied through getters/setters so the generated client
 * bundle can keep one small action owner without giving it Settings, routing or
 * Host-context authority.
 */
export function createClientMaintenanceActions({
  fetchImpl,
  t,
  getTestState,
  setTestState,
  getUpdateState,
  setUpdateState,
  getSelfUpdateState,
  setSelfUpdateState,
  confirmImpl,
  alertImpl,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('client maintenance actions require fetch')
  const translate = typeof t === 'function' ? t : (key) => String(key)

  const diagnosticError = (value, fallback) => {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (value && typeof value.message === 'string' && value.message.trim() !== '') {
      return value.message.trim()
    }
    return fallback
  }

  const runTestConnection = async () => {
    if (getTestState?.()?.status === 'running') return
    setTestState?.({ status: 'running' })
    try {
      const response = await fetchImpl('/_dsh/vision-router/test-connection')
      const result = await response.json().catch(() => undefined)
      setTestState?.({ status: 'done', result })
    } catch (error) {
      setTestState?.({
        status: 'done',
        result: { ok: false, error: error && error.message ? error.message : String(error) },
      })
    }
  }

  const requestDesktopScreenshotPermission = () => {
    // Fire-and-forget: the native permission dialog must never hold Settings
    // save completion open. The actual screenshot tool still reports denial.
    try {
      void Promise.resolve(fetchImpl('/_dsh/vision-router/request-screenshot-permission', {
        method: 'POST',
        cache: 'no-store',
      })).catch(() => {})
    } catch {
      // Permission prompting is best-effort after an already-landed setting.
    }
  }

  const runUpdateCheck = async (force = false) => {
    const current = getUpdateState?.() ?? {}
    if (current.status === 'running') return
    setUpdateState?.({ status: 'running', result: current.result })
    try {
      const response = await fetchImpl(
        '/_dsh/vision-router/update-check' + (force ? '?force=1' : ''),
        { cache: 'no-store' },
      )
      const result = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw new Error(diagnosticError(result && result.error, `HTTP ${response.status}`))
      }
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        throw new Error(translate('updateInvalidResponse'))
      }
      setUpdateState?.({ status: 'done', result })
    } catch (error) {
      setUpdateState?.({
        status: 'done',
        result: {
          ok: false,
          error: error && error.message ? error.message : String(error),
        },
      })
    }
  }

  const runSelfUpdate = async () => {
    if (getSelfUpdateState?.()?.status === 'running') return
    const checked = getUpdateState?.()?.result
    const auto = checked && checked.autoUpdate
    if (!checked || checked.ok !== true || checked.updateAvailable !== true || !auto || !auto.token) return
    if (typeof confirmImpl === 'function' && confirmImpl(translate('updateConfirm')) !== true) return
    setSelfUpdateState?.({ status: 'running', result: undefined })
    try {
      const response = await fetchImpl('/_dsh/vision-router/self-update', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'x-dsh-vision-router-update-token': auto.token },
      })
      const result = await response.json().catch(() => undefined)
      if (!response.ok) {
        throw new Error(diagnosticError(result && result.error, `HTTP ${response.status}`))
      }
      if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
        throw new Error(translate('updateInvalidResponse'))
      }
      setSelfUpdateState?.({ status: 'done', result })
    } catch (error) {
      setSelfUpdateState?.({
        status: 'error',
        result: { ok: false, error: error && error.message ? error.message : String(error) },
      })
    }
  }

  const openLogFolder = async () => {
    try {
      const response = await fetchImpl('/_dsh/vision-router/logs', {
        method: 'POST',
        cache: 'no-store',
      })
      const result = await response.json().catch(() => undefined)
      if (!response.ok || !result || result.ok !== true) {
        throw new Error(result && result.error ? result.error : `HTTP ${response.status}`)
      }
      return result
    } catch (error) {
      if (typeof alertImpl === 'function') {
        alertImpl(
          translate('openLogFolderFailed') + '：' +
            (error && error.message ? error.message : String(error)),
        )
      }
      return undefined
    }
  }

  return {
    runTestConnection,
    requestDesktopScreenshotPermission,
    runUpdateCheck,
    runSelfUpdate,
    openLogFolder,
  }
}
