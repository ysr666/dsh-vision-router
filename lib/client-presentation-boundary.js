import { htmlHasScriptMarker } from './html-script-marker.js'
import {
  CLIENT_PRESENTATION_PRELUDE as BASE_CLIENT_PRESENTATION_PRELUDE,
  resolveVisionModePair,
} from './client-presentation-boundary-main.js'
import {
  installClientHostCompatibility,
} from './client-host-compat-prelude.js'
import { installVisionModelVisibilityBoundary } from './vision-model-visibility-boundary.js'

const CLIENT_PRESENTATION_MARK = 'data-vision-router-presentation-boundary'

const VISION_TOGGLE_TEXT_GLYPH = String.raw`          React.createElement('span', { 'aria-hidden': 'true', style: { fontSize: 13, lineHeight: 1 } }, '👁'),
          React.createElement('span', null, t('label')),
          active
            ? React.createElement('span', {
                'aria-hidden': 'true',
                style: { fontSize: 12, lineHeight: 1, fontWeight: 800, marginLeft: 1 }
              }, '✓')
            : null`

const VISION_TOGGLE_FIXED_SVG = String.raw`          React.createElement('svg', {
            width: 14,
            height: 14,
            viewBox: '0 0 14 14',
            fill: 'none',
            'aria-hidden': 'true',
            focusable: 'false',
            style: { display: 'block', flex: '0 0 auto' }
          }, React.createElement('path', {
            fillRule: 'evenodd',
            clipRule: 'evenodd',
            d: 'M7 2.25c-2.84 0-5.04 1.69-6.25 4.25a1.15 1.15 0 0 0 0 1C1.96 10.06 4.16 11.75 7 11.75s5.04-1.69 6.25-4.25a1.15 1.15 0 0 0 0-1C12.04 3.94 9.84 2.25 7 2.25Zm0 1.25c2.16 0 3.96 1.21 5.05 3.5C10.96 9.29 9.16 10.5 7 10.5S3.04 9.29 1.95 7C3.04 4.71 4.84 3.5 7 3.5Zm0 1.25A2.25 2.25 0 1 0 7 9.25a2.25 2.25 0 0 0 0-4.5Zm0 1.25a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z',
            fill: 'currentColor'
          })),
          React.createElement('span', null, t('label')),
          active
            ? React.createElement('svg', {
                width: 12,
                height: 12,
                viewBox: '0 0 14 14',
                fill: 'none',
                'aria-hidden': 'true',
                focusable: 'false',
                style: { display: 'block', flex: '0 0 auto', marginLeft: 1 }
              }, React.createElement('path', {
                d: 'M2.75 7.15 5.6 10 11.25 4.35',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round'
              }))
            : null`

export function transformVisionModeToggleIcons(source = BASE_CLIENT_PRESENTATION_PRELUDE) {
  const input = String(source)
  if (!input.includes(VISION_TOGGLE_TEXT_GLYPH)) {
    throw new Error('vision toggle icon transform anchor missing')
  }
  return input.replace(VISION_TOGGLE_TEXT_GLYPH, VISION_TOGGLE_FIXED_SVG)
}

export const CLIENT_PRESENTATION_PRELUDE = transformVisionModeToggleIcons()

export {
  resolveVisionModePair,
}

export function injectClientPresentationBoundary(html) {
  if (typeof html !== 'string' || htmlHasScriptMarker(html, CLIENT_PRESENTATION_MARK)) return html
  const safe = CLIENT_PRESENTATION_PRELUDE.replace(/<\/script/gi, '<\\/script')
  const script = `<script ${CLIENT_PRESENTATION_MARK}>${safe}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installClientPresentationBoundary(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectClientPresentationBoundary),
      'vision-router: client presentation boundary',
    )
  })
  // Keep Host-version compatibility in its own capability-detected prelude.
  // This lets the large legacy client factory stay byte-stable while alpha/new
  // Hosts expose their current Remote/Connection seams to it.
  installClientHostCompatibility(ctx)
  // #286 keeps real wrapper routes registered while hiding only confidently
  // owned wrappers from DSH's stock model-selection presentation. Compose that
  // presentation boundary here so v2 can retain its hardened script-marker
  // injector without duplicating the large composer implementation.
  installVisionModelVisibilityBoundary(ctx)
}
