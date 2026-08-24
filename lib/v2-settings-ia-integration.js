import { htmlHasScriptMarker } from './html-script-marker.js'

const V2_SETTINGS_IA_MARK = 'data-vision-router-v2-settings-ia'

export const V2_SETTINGS_IA_STYLE = String.raw`
/*
 * v2 routing already mounts inside #vr-vision-backend-chain, which belongs to
 * Settings → Vision Router → General.  #299 made that chain part of the new IA,
 * so keep v2's behavior/state machine but remove the nested-card chrome that
 * made it look like a second settings product bolted on top.
 *
 * Scope every override to the new IA root. The legacy plugin compatibility
 * surface keeps v2's original presentation if it ever renders there.
 */
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel].vr-routing-panel{
  margin:0 0 14px;
  padding:0 0 14px;
  border:0;
  border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent);
  border-radius:0;
  background:transparent;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-head{
  margin:0 0 8px;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-title{
  font-size:14px;
  font-weight:650;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-sub{
  max-width:760px;
  margin-top:4px;
  color:inherit;
  opacity:.68;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-badge{
  border-color:color-mix(in srgb,currentColor 16%,transparent);
  color:inherit;
  opacity:.72;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-label{
  margin-top:9px;
  color:inherit;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-choice{
  border-color:color-mix(in srgb,currentColor 16%,transparent);
  color:inherit;
  opacity:.78;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-choice[data-active="1"]{
  background:color-mix(in srgb,currentColor 9%,transparent);
  border-color:color-mix(in srgb,currentColor 28%,transparent);
  color:inherit;
  opacity:1;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-note{
  color:inherit;
  opacity:.64;
}
.vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-error{
  opacity:1;
}
@media (max-width:760px){
  .vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-head{
    display:block;
  }
  .vr-settings-ia-root #vr-vision-backend-chain > [data-vr-routing-settings-panel] .vr-routing-badge{
    display:inline-block;
    margin-top:7px;
  }
}
`

export function injectV2SettingsIaIntegration(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, V2_SETTINGS_IA_MARK)) return html
  const style = `<style ${V2_SETTINGS_IA_MARK}>${V2_SETTINGS_IA_STYLE}</style>`
  const closeHead = html.indexOf('</head>')
  return closeHead === -1 ? `${html}${style}` : `${html.slice(0, closeHead)}${style}${html.slice(closeHead)}`
}

export function installV2SettingsIaIntegration(ctx) {
  if (!ctx || typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectV2SettingsIaIntegration),
      'vision-router: integrate v2 routing controls into settings IA',
    )
  })
}
