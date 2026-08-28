export const DSH_SUPPORT_WINDOW = Object.freeze({
  dvrTrain: '2.0.x',
  minimum: '0.1.0-rc.6',
  previous: '0.1.0-rc.8',
  current: '0.1.1-rc.2',
  canary: '0.1.2-alpha.1',
  next: Object.freeze({
    dvrTrain: '2.1.0',
    minimum: '0.1.0-rc.8',
  }),
})

export function supportWindowUpgradeAdvice(capabilities = {}) {
  const batchAttachments = capabilities?.batchAttachments
  const maxImageDimension = capabilities?.maxImageDimension

  if (batchAttachments === false || maxImageDimension === false) {
    return Object.freeze({
      level: 'recommended',
      code: 'HOST_BELOW_NEXT_FLOOR_CAPABILITIES',
      message: `upgrade recommended before DVR ${DSH_SUPPORT_WINDOW.next.dvrTrain}; the next announced minimum Host is DSH ${DSH_SUPPORT_WINDOW.next.minimum}`,
    })
  }

  if (batchAttachments === 'unknown' || maxImageDimension === 'unknown') {
    return Object.freeze({
      level: 'unknown',
      code: 'HOST_NEXT_FLOOR_UNKNOWN',
      message: `next DVR minimum is announced as DSH ${DSH_SUPPORT_WINDOW.next.minimum}, but this read-only probe cannot prove the relevant Host capabilities`,
    })
  }

  return Object.freeze({
    level: 'ok',
    code: 'HOST_NEXT_FLOOR_CAPABLE',
    message: `Host exposes the attachment capabilities expected by the announced DVR ${DSH_SUPPORT_WINDOW.next.dvrTrain} floor`,
  })
}
