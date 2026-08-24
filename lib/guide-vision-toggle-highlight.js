const CLIENT_PRELUDE_MARK = 'data-vision-router-guide-toggle-highlight'

export function unionGuideRects(first, second) {
  if (!first) return second
  if (!second) return first
  const left = Math.min(Number(first.left ?? first.x), Number(second.left ?? second.x))
  const top = Math.min(Number(first.top ?? first.y), Number(second.top ?? second.y))
  const right = Math.max(Number(first.right ?? (first.x + first.width)), Number(second.right ?? (second.x + second.width)))
  const bottom = Math.max(Number(first.bottom ?? (first.y + first.height)), Number(second.bottom ?? (second.y + second.height)))
  return {
    x: left,
    y: top,
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  }
}

export const GUIDE_VISION_TOGGLE_HIGHLIGHT_PRELUDE = String.raw`(function(){
  'use strict';

  var STEP1_PROMPT = '.vr-guide-prompt[data-vr-step="step1"]';
  var VISION_TOGGLE = '[data-vision-router-mode-toggle="true"]';
  var MODEL_SELECTORS = [
    '[data-slot="conversation.input.model"] button[aria-haspopup="menu"]',
    '[aria-label^="选择模型"], [aria-label^="Select model"]',
    '[data-composer-card] button[aria-haspopup="menu"]'
  ];
  var frame;
  var installed = false;
  var spotObserver;
  var observedHole;
  var observedRing;

  function usable(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    var rect = el.getBoundingClientRect();
    if (!rect || rect.width < 6 || rect.height < 6) return false;
    var vw = window.innerWidth || 1;
    var vh = window.innerHeight || 1;
    return rect.right > 0 && rect.bottom > 0 && rect.left < vw && rect.top < vh;
  }

  function findModelSelector() {
    for (var s = 0; s < MODEL_SELECTORS.length; s++) {
      var list;
      try { list = Array.prototype.slice.call(document.querySelectorAll(MODEL_SELECTORS[s])); }
      catch (_) { continue; }
      for (var i = list.length - 1; i >= 0; i--) {
        if (usable(list[i])) return list[i];
      }
    }
    return undefined;
  }

  function unionRects(first, second) {
    var left = Math.min(first.left, second.left);
    var top = Math.min(first.top, second.top);
    var right = Math.max(first.right, second.right);
    var bottom = Math.max(first.bottom, second.bottom);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  function assignRect(el, rect, pad, radius) {
    var next = {
      left: Math.max(0, rect.x - pad) + 'px',
      top: Math.max(0, rect.y - pad) + 'px',
      width: rect.width + pad * 2 + 'px',
      height: rect.height + pad * 2 + 'px',
      borderRadius: radius + 'px'
    };
    if (el.style.left !== next.left) el.style.left = next.left;
    if (el.style.top !== next.top) el.style.top = next.top;
    if (el.style.width !== next.width) el.style.width = next.width;
    if (el.style.height !== next.height) el.style.height = next.height;
    if (el.style.borderRadius !== next.borderRadius) el.style.borderRadius = next.borderRadius;
  }

  function disconnectSpotObserver() {
    if (spotObserver) spotObserver.disconnect();
    spotObserver = undefined;
    observedHole = undefined;
    observedRing = undefined;
  }

  function watchSpot(hole, ring) {
    if (observedHole === hole && observedRing === ring && spotObserver) return;
    disconnectSpotObserver();
    if (typeof MutationObserver !== 'function') return;
    observedHole = hole;
    observedRing = ring;
    spotObserver = new MutationObserver(schedule);
    spotObserver.observe(hole, { attributes: true, attributeFilter: ['style'] });
    spotObserver.observe(ring, { attributes: true, attributeFilter: ['style'] });
  }

  function sync() {
    frame = undefined;
    if (!document.querySelector(STEP1_PROMPT)) {
      disconnectSpotObserver();
      return;
    }
    var toggle = document.querySelector(VISION_TOGGLE);
    var model = findModelSelector();
    var hole = document.querySelector('.vr-guide-spot-hole');
    var ring = document.querySelector('.vr-guide-spot-ring');
    if (!usable(toggle) || !usable(model) || !hole || !ring) return;

    var rect = unionRects(toggle.getBoundingClientRect(), model.getBoundingClientRect());
    // Match the guide runtime's existing spotlight geometry so both controls
    // read as one target instead of drawing a second, competing highlight.
    assignRect(hole, rect, 9, 14);
    assignRect(ring, rect, 5, 16);
    watchSpot(hole, ring);
  }

  function schedule() {
    if (frame !== undefined) return;
    if (typeof window.requestAnimationFrame === 'function') {
      frame = window.requestAnimationFrame(sync);
    } else {
      frame = window.setTimeout(sync, 0);
    }
  }

  function install() {
    if (installed || typeof document === 'undefined') return;
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', install, { once: true });
      return;
    }
    installed = true;
    if (typeof MutationObserver === 'function') {
      var bodyObserver = new MutationObserver(schedule);
      // Only child-list changes are needed here. Once step 1 is active, a
      // narrowly scoped observer on the two spotlight nodes follows the guide's
      // own geometry writes without reviving the old body/class observer jank.
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener('resize', schedule, { passive: true });
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    schedule();
  }

  try { install(); } catch (_) {}
})();`

export function injectGuideVisionToggleHighlight(html) {
  if (typeof html !== 'string' || html.includes(CLIENT_PRELUDE_MARK)) return html
  const script = `<script ${CLIENT_PRELUDE_MARK}>${GUIDE_VISION_TOGGLE_HIGHLIGHT_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installGuideVisionToggleHighlight(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectGuideVisionToggleHighlight),
      'vision-router: onboarding vision-toggle spotlight',
    )
  })
}
