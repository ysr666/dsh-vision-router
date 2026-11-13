import semver from 'semver'

export const DSH_SUPPORT_WINDOW = Object.freeze({
  dvrTrain: '3.2.x',
  minimum: '0.2.1-rc.5',
  currentRecommended: '0.2.2-rc.1',
  nodeMinimum: '24.9.0',
})

export const DSH_VERIFICATION_EVIDENCE = Object.freeze({
  exactFloor: '0.2.1-rc.5',
  exactRecommended: '0.2.2-rc.1',
  // Qualified exact-host evidence is distinct from the recommended upgrade target.
  exactVerified: Object.freeze(['0.2.1-rc.5', '0.2.2-rc.1', '0.2.2-rc.2', '0.2.2-rc.3']),
  stableCanaryDistTag: 'latest',
  nextCanaryDistTag: 'next',
  previewCanaryDistTag: 'alpha',
})

export const DSH_SUPPORTED_RANGE = '>=0.2.1-rc.5 <0.3.0-0'

/** Version evidence does not replace a required-capability check. */
export function supportWindowUpgradeAdvice(capabilities = {}, {
  nodeVersion = process.versions.node,
  hostVersion,
} = {}) {
  const node = semver.valid(String(nodeVersion).replace(/^v/, ''))
  if (!node) {
    return Object.freeze({
      level: 'unknown', code: 'NODE_VERSION_UNVERIFIED',
      message: 'Node runtime version was not established',
    })
  }
  if (!semver.satisfies(node, '>=24.9.0')) {
    return Object.freeze({
      level: 'required', code: 'NODE_BELOW_CURRENT_FLOOR',
      message: `DVR ${DSH_SUPPORT_WINDOW.dvrTrain} requires Node.js >=${DSH_SUPPORT_WINDOW.nodeMinimum}; current Node is ${node}`,
    })
  }
  if (hostVersion !== undefined && hostVersion !== null) {
    const host = semver.valid(String(hostVersion).replace(/^v/, ''))
    if (!host) {
      return Object.freeze({
        level: 'unknown', code: 'HOST_VERSION_UNVERIFIED',
        message: 'DSH Host version could not be validated against the new support window',
      })
    }
    if (!semver.satisfies(host, DSH_SUPPORTED_RANGE, { includePrerelease: true })) {
      return Object.freeze({
        level: 'required', code: 'HOST_BELOW_CURRENT_FLOOR_VERSION',
        message: `DVR ${DSH_SUPPORT_WINDOW.dvrTrain} supports DSH ${DSH_SUPPORTED_RANGE}; detected ${host}`,
      })
    }
  }
  if (capabilities?.batchAttachments === false || capabilities?.maxImageDimension === false) {
    return Object.freeze({
      level: 'required', code: 'HOST_BELOW_CURRENT_FLOOR_CAPABILITIES',
      message: 'Host lacks the attachment capabilities required for DVR 3.2',
    })
  }
  if (!hostVersion) {
    return Object.freeze({
      level: 'unknown', code: 'HOST_VERSION_UNVERIFIED',
      message: `DSH Host version is unverified. DVR ${DSH_SUPPORT_WINDOW.dvrTrain} requires ${DSH_SUPPORTED_RANGE}; attachment capabilities alone cannot prove the version`,
    })
  }
  if (capabilities?.batchAttachments !== true || capabilities?.maxImageDimension !== true) {
    return Object.freeze({
      level: 'unknown', code: 'HOST_CURRENT_FLOOR_UNKNOWN',
      message: 'DSH version is supported, but required runtime attachment capabilities are not proven',
    })
  }
  // Admission is an open 0.2.x train on purpose, not blanket evidence.
  // A later Host or Node major is not automatically verified by the exact
  // pinned-release Node 24.9/24.21 matrix; Doctor reports unknown, not green.
  if (semver.major(node) !== 24) {
    return Object.freeze({
      level: 'unknown', code: 'NODE_FORWARD_MAJOR_UNVERIFIED',
      message: `Node ${node} meets the declared >=24.9 floor, but is outside the verified Node 24 test train`,
    })
  }
  const exactHost = semver.valid(String(hostVersion).replace(/^v/, ''))
  if (!DSH_VERIFICATION_EVIDENCE.exactVerified.includes(exactHost)) {
    return Object.freeze({
      level: 'unknown', code: 'HOST_FORWARD_RELEASE_UNVERIFIED',
      message: `DSH ${hostVersion} meets the 0.2.x admission range but has no exact-release acceptance evidence`,
    })
  }
  return Object.freeze({
    level: 'ok', code: 'HOST_CURRENT_FLOOR_CAPABLE',
    message: `DSH ${hostVersion} and required attachment capabilities satisfy the DVR 3.2 floor`,
  })
}

export function formatDshSupportWindowLines(capabilities = {}, options = {}) {
  const advice = supportWindowUpgradeAdvice(capabilities, options)
  return Object.freeze([
    'DSH Host support window:',
    `  DVR train: ${DSH_SUPPORT_WINDOW.dvrTrain}`,
    `  minimum supported Host: ${DSH_SUPPORT_WINDOW.minimum}`,
    `  current recommended Host: ${DSH_SUPPORT_WINDOW.currentRecommended}`,
    `  minimum supported Node.js: ${DSH_SUPPORT_WINDOW.nodeMinimum}`,
    `  support floor: DSH ${DSH_SUPPORTED_RANGE}`,
    'DSH compatibility verification evidence:',
    `  exact supported Host floor: ${DSH_VERIFICATION_EVIDENCE.exactFloor}`,
    `  exact recommended Host: ${DSH_VERIFICATION_EVIDENCE.exactRecommended}`,
    `  verified exact Host releases: ${DSH_VERIFICATION_EVIDENCE.exactVerified.join(', ')}`,
    `  scheduled published canary: npm dist-tag ${DSH_VERIFICATION_EVIDENCE.stableCanaryDistTag}`,
    `  scheduled next/rc canary: npm dist-tag ${DSH_VERIFICATION_EVIDENCE.nextCanaryDistTag}`,
    `  scheduled alpha/pre-release canary: npm dist-tag ${DSH_VERIFICATION_EVIDENCE.previewCanaryDistTag}`,
    `  upgrade advice: ${advice.level} (${advice.code}) — ${advice.message}`,
  ])
}
