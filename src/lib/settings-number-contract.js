export const SETTINGS_NUMBER_META = Object.freeze({
  timeoutMs: Object.freeze({ min: 1000, max: 600000, step: 1 }),
  visionTaskTimeoutMs: Object.freeze({ min: 1000, max: 180000, step: 1000 }),
  ocrTimeoutMs: Object.freeze({ min: 1000, max: 120000, step: 1 }),
  downscaleMaxPixels: Object.freeze({ min: 1000, max: 100000000, step: 1 }),
  cacheTtlSeconds: Object.freeze({ min: 0, max: 31536000, step: 1 }),
  cacheMaxEntries: Object.freeze({ min: 1, max: 100000, step: 1 }),
  visionDepthMaxCalls: Object.freeze({ min: 0, max: 100, step: 1 }),
  visionTurnBudgetMs: Object.freeze({ min: 0, max: 600000, step: 1000 }),
})

export function parseSettingsNumber(key, raw, { allowClear = false } = {}) {
  const meta = SETTINGS_NUMBER_META[key]
  if (!meta) return undefined
  if (raw === '' || raw === null || raw === undefined) return allowClear ? { clear: true } : undefined
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value)) return undefined
  if (value < meta.min || value > meta.max) return undefined
  if ((value - meta.min) % meta.step !== 0) return undefined
  return { value }
}

export function formatDurationMs(value, { unlimitedZero = false } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number)) return undefined
  if (unlimitedZero && number === 0) return 'unlimited'
  if (number % 1000 === 0) return `${number / 1000}s`
  return `${number}ms`
}
