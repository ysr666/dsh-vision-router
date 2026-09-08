export const DSH_SUPPORT_WINDOW = Object.freeze({
  dvrTrain: '2.1.x',
  minimum: '0.1.0-rc.8',
  currentStable: '0.1.2-rc.1',
})

export const DSH_VERIFICATION_EVIDENCE = Object.freeze({
  exactStable: '0.1.2-rc.1',
  exactPreview: '0.1.3-alpha.2',
  stableCanaryDistTag: 'latest',
  previewCanaryDistTag: 'alpha',
})

export function supportWindowUpgradeAdvice(capabilities = {}) {
  const batchAttachments = capabilities?.batchAttachments
  const maxImageDimension = capabilities?.maxImageDimension

  if (batchAttachments === false || maxImageDimension === false) {
    return Object.freeze({
      level: 'required',
      code: 'HOST_BELOW_CURRENT_FLOOR_CAPABILITIES',
      message: `Host lacks attachment capabilities expected by DVR ${DSH_SUPPORT_WINDOW.dvrTrain}; the minimum supported Host is DSH ${DSH_SUPPORT_WINDOW.minimum}`,
    })
  }

  if (batchAttachments === 'unknown' || maxImageDimension === 'unknown') {
    return Object.freeze({
      level: 'unknown',
      code: 'HOST_CURRENT_FLOOR_UNKNOWN',
      message: `DVR ${DSH_SUPPORT_WINDOW.dvrTrain} requires DSH ${DSH_SUPPORT_WINDOW.minimum} or newer, but this read-only probe cannot prove the relevant Host capabilities`,
    })
  }

  return Object.freeze({
    level: 'ok',
    code: 'HOST_CURRENT_FLOOR_CAPABLE',
    message: `Host exposes the attachment capabilities expected by the DVR ${DSH_SUPPORT_WINDOW.dvrTrain} support floor`,
  })
}

export function formatDshSupportWindowLines(capabilities = {}) {
  const advice = supportWindowUpgradeAdvice(capabilities)
  return Object.freeze([
    'DSH Host support window:',
    `  DVR train: ${DSH_SUPPORT_WINDOW.dvrTrain}`,
    `  minimum supported Host: ${DSH_SUPPORT_WINDOW.minimum}`,
    `  current stable Host: ${DSH_SUPPORT_WINDOW.currentStable}`,
    `  support floor: DVR ${DSH_SUPPORT_WINDOW.dvrTrain} -> DSH ${DSH_SUPPORT_WINDOW.minimum}`,
    'DSH compatibility verification evidence:',
    `  exact stable: ${DSH_VERIFICATION_EVIDENCE.exactStable}`,
    `  exact preview (not a support claim): ${DSH_VERIFICATION_EVIDENCE.exactPreview}`,
    `  scheduled stable canary: npm dist-tag ${DSH_VERIFICATION_EVIDENCE.stableCanaryDistTag}`,
    `  scheduled preview canary: npm dist-tag ${DSH_VERIFICATION_EVIDENCE.previewCanaryDistTag}`,
    `  upgrade advice: ${advice.level} (${advice.code}) — ${advice.message}`,
  ])
}
