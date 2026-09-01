import { CAPABILITY_BENCHMARK_CLIENT } from './vision-capability-benchmark-client.js'
import { htmlHasScriptMarker } from './html-script-marker.js'

const CLIENT_MARK = 'data-vision-router-capability-benchmark'

const DOCUMENT_ELEMENT_OBSERVER = "if(typeof MutationObserver==='function'&&document.documentElement){var observer=new MutationObserver(function(records){for(var i=0;i<records.length;i+=1){var added=records[i]&&records[i].addedNodes;for(var j=0;added&&j<added.length;j+=1){if(nodeTouchesChain(added[j])){scheduleScan(false);return;}}}});observer.observe(document.documentElement,{childList:true,subtree:true});}"

const DOCUMENT_OBSERVER = "if(typeof MutationObserver==='function'){var observer=new MutationObserver(function(records){for(var i=0;i<records.length;i+=1){var added=records[i]&&records[i].addedNodes;for(var j=0;added&&j<added.length;j+=1){if(nodeTouchesChain(added[j])){scheduleScan(false);return;}}}});observer.observe(document,{childList:true,subtree:true});}"

function replaceRequired(source, from, to) {
  if (!source.includes(from)) {
    throw new Error('benchmark lifecycle transform anchor missing')
  }
  return source.replace(from, to)
}

/**
 * DSH may replace document.documentElement while the browser shell boots.
 * Observe the stable Document node instead, so the benchmark controls keep
 * seeing both shell-root replacement and later lazy Settings card mounts
 * without a permanent polling/watchdog loop.
 */
export function stabilizeCapabilityBenchmarkClient(source = CAPABILITY_BENCHMARK_CLIENT) {
  return replaceRequired(source, DOCUMENT_ELEMENT_OBSERVER, DOCUMENT_OBSERVER)
}

export const CAPABILITY_BENCHMARK_LIFECYCLE_CLIENT = stabilizeCapabilityBenchmarkClient()

export function injectCapabilityBenchmarkLifecycleClient(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, CLIENT_MARK)) return html
  const script = `<script ${CLIENT_MARK}>${CAPABILITY_BENCHMARK_LIFECYCLE_CLIENT.replace(/<\/script/gi, '<\\/script')}</script>`
  const head = html.indexOf('<head>')
  return head === -1 ? `${script}${html}` : `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
}

export function installCapabilityBenchmarkLifecycleClient(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectCapabilityBenchmarkLifecycleClient),
      'vision-router: capability benchmark Host presentation client controls',
    )
  })
}
