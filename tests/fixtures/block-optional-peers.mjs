// Child-process resolve hook that makes the optional peers unresolvable.
//
// The point of the probe is to reproduce "a profile where the optional peers were
// never installed" without touching node_modules, so both the pass and the failure
// are deterministic: a static import of a blocked peer throws at link time exactly
// like ERR_MODULE_NOT_FOUND does in the field (issue #719).
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
const blocked = [...new Set([
  ...Object.entries(manifest.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta?.optional === true)
    .map(([name]) => name),
  // Even though engines.dsh now replaces the legacy DSH peer declarations,
  // these Host-provided packages must remain unavailable to the plugin's
  // activation module to preserve the original #719 negative control.
  '@deepseek-ai/dsh-anonymous-user-id',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-storage-domain',
])]

export async function resolve(specifier, context, next) {
  for (const peer of blocked) {
    if (specifier === peer || specifier.startsWith(peer + '/')) {
      const error = new Error("Cannot find package '" + specifier + "' (optional peer blocked by the test probe)")
      error.code = 'ERR_MODULE_NOT_FOUND'
      throw error
    }
  }
  return next(specifier, context)
}
