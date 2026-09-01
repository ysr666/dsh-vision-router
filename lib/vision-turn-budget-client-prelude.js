const CLIENT_PRELUDE_MARK = 'data-vision-router-turn-budget'

export const VISION_TURN_BUDGET_CLIENT_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET = 'dsh-vision-router';
  var SETTINGS_SECTION_ID = 'vision-router';
  var TURN_BUDGET_FIELD = 'visionTurnBudgetMs';
  var DEPTH_CAP_FIELD = 'visionDepthMaxCalls';
  var DEPTH_FIELD = 'visionDepth';
  var DEFAULT_TURN_BUDGET_MS = 0;
  var MIN_TURN_BUDGET_MS = 10000;
  var MAX_TURN_BUDGET_MS = 600000;
  var DEFAULT_DEPTH_CAP = 4;
  var MIN_DEPTH_CAP = 1;
  var MAX_DEPTH_CAP = 100;
  var contexts = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var strategyScopes = typeof WeakMap === 'function' ? new WeakMap() : undefined;
  var reactWrappers = typeof WeakMap === 'function' ? new WeakMap() : undefined;

  function patchCopy(namespace, dictionaries) {
    if (namespace !== SETTINGS_SECTION_ID || !dictionaries || typeof dictionaries !== 'object') return dictionaries;
    var next = Object.assign({}, dictionaries);
    if (next.zh && typeof next.zh === 'object') {
      next.zh = Object.assign({}, next.zh, {
        visionDepthFast: '快速（优先整体判断）',
        visionDepthStandard: '标准（按需查证，默认）',
        visionDepthDeep: '细致（主动交叉验证）',
        hintVisionDepth: '看图深度只决定识图策略，不限制调用次数：快速优先整体判断，标准按问题需要查证，细致会主动做更多局部检查与交叉验证。如需限制调用次数，请启用下方「限制深挖次数」。',
        depthCapTitle: '限制深挖次数',
        depthCapHint: '默认关闭，不限制视觉证据调用次数。启用后可设置本轮最多允许多少次成功的深挖证据调用；bootstrap 预识别不计入，失败或空证据调用不占次数。',
        depthCapValueLabel: '最多深挖次数',
        depthCapInvalid: '请输入 1–100 之间的整数。',
        depthCapSaved: '已保存',
        depthCapSaveFailed: '保存失败',
        visionTurnBudgetTitle: '整轮视觉工具时间上限',
        visionTurnBudgetHint: '可选的整轮 Vision Router 视觉工具总时间上限。默认不限制；填 0 表示不限制。单次视觉任务仍受独立超时保护。',
        visionTurnBudgetInvalid: '请输入 0，或 10000–600000 之间的整数毫秒值。',
        visionTurnBudgetSaved: '已保存',
        visionTurnBudgetSaveFailed: '保存失败'
      });
    }
    if (next.en && typeof next.en === 'object') {
      next.en = Object.assign({}, next.en, {
        visionDepthFast: 'Quick (overall-first)',
        visionDepthStandard: 'Standard (evidence as needed, default)',
        visionDepthDeep: 'Thorough (proactive cross-checking)',
        hintVisionDepth: 'Vision depth chooses the inspection strategy, not a call-count limit: Quick stays overall-first, Standard verifies evidence as needed, and Thorough proactively inspects details and cross-checks important claims. To cap calls, enable “Limit deep-dive calls” below.',
        depthCapTitle: 'Limit deep-dive calls',
        depthCapHint: 'Off by default, so visual evidence calls are unlimited. Enable this to cap successful deep-evidence calls for the turn. The bootstrap pre-scan does not count, and failed or empty-evidence calls do not consume the cap.',
        depthCapValueLabel: 'Maximum deep-dive calls',
        depthCapInvalid: 'Enter an integer from 1 to 100.',
        depthCapSaved: 'Saved',
        depthCapSaveFailed: 'Save failed',
        visionTurnBudgetTitle: 'Whole-turn vision time limit',
        visionTurnBudgetHint: 'Optional total time limit for Vision Router visual tools across the turn. Unlimited by default; enter 0 for unlimited. Individual visual tasks still have their own timeout.',
        visionTurnBudgetInvalid: 'Enter 0, or an integer from 10000 to 600000 milliseconds.',
        visionTurnBudgetSaved: 'Saved',
        visionTurnBudgetSaveFailed: 'Save failed'
      });
    }
    return next;
  }

  function wrapLocale(locale) {
    if (!locale || (typeof locale !== 'object' && typeof locale !== 'function')) return locale;
    return new Proxy(locale, {
      get: function(target, property) {
        if (property === 'register') {
          var register = Reflect.get(target, property, target);
          if (typeof register !== 'function') return register;
          return function(namespace, dictionaries) {
            var rest = Array.prototype.slice.call(arguments, 2);
            return register.apply(target, [namespace, patchCopy(namespace, dictionaries)].concat(rest));
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function collectOptionValues(node, out) {
    if (Array.isArray(node)) {
      node.forEach(function(entry){ collectOptionValues(entry, out); });
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (node.type === 'option' && node.props && typeof node.props.value === 'string') out.add(node.props.value);
    if (node.props && node.props.children !== undefined) collectOptionValues(node.props.children, out);
  }

  function stripLegacyCustomOption(node) {
    if (Array.isArray(node)) {
      return node.map(stripLegacyCustomOption).filter(function(entry){ return entry !== null; });
    }
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'option' && node.props && node.props.value === 'custom') return null;
    return node;
  }

  function wrapReact(React) {
    if (!React || typeof React !== 'object' || typeof React.createElement !== 'function') return React;
    if (reactWrappers && reactWrappers.has(React)) return reactWrappers.get(React);
    var wrapped = new Proxy(React, {
      get: function(target, property) {
        if (property !== 'createElement') return Reflect.get(target, property, target);
        return function(type, props) {
          var args = Array.prototype.slice.call(arguments);
          if (type === 'select' && args.length > 2) {
            var values = new Set();
            for (var i = 2; i < args.length; i++) collectOptionValues(args[i], values);
            if (values.has('fast') && values.has('standard') && values.has('deep') && values.has('custom')) {
              for (var j = 2; j < args.length; j++) args[j] = stripLegacyCustomOption(args[j]);
            }
          }
          return target.createElement.apply(target, args);
        };
      }
    });
    if (reactWrappers) reactWrappers.set(React, wrapped);
    return wrapped;
  }

  function projectStrategySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.value || typeof snapshot.value !== 'object') return snapshot;
    if (snapshot.value[DEPTH_FIELD] !== 'custom') return snapshot;
    return Object.assign({}, snapshot, {
      value: Object.assign({}, snapshot.value, { visionDepth: 'standard' })
    });
  }

  function strategyScope(scope) {
    if (!scope || (typeof scope !== 'object' && typeof scope !== 'function')) return scope;
    if (strategyScopes && strategyScopes.has(scope)) return strategyScopes.get(scope);
    var wrapped = new Proxy(scope, {
      get: function(target, property) {
        if (property === 'getSnapshot') {
          var getSnapshot = Reflect.get(target, property, target);
          if (typeof getSnapshot !== 'function') return getSnapshot;
          return function(){ return projectStrategySnapshot(getSnapshot.call(target)); };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (strategyScopes) strategyScopes.set(scope, wrapped);
    return wrapped;
  }

  function makeDepthCapCard(React) {
    return function VisionRouterDepthCapCard(props) {
      var scope = props && props.scope;
      var t = props && typeof props.t === 'function' ? props.t : function(key){ return key; };
      var subscribe = React.useMemo(function() {
        return scope && typeof scope.subscribe === 'function' ? scope.subscribe.bind(scope) : function(){ return function(){}; };
      }, [scope]);
      var getSnapshot = React.useMemo(function() {
        return scope && typeof scope.getSnapshot === 'function' ? scope.getSnapshot.bind(scope) : function(){ return undefined; };
      }, [scope]);
      var snapshot = React.useSyncExternalStore(subscribe, getSnapshot);
      var enabledPair = React.useState(undefined);
      var enabledDraft = enabledPair[0];
      var setEnabledDraft = enabledPair[1];
      var capPair = React.useState(undefined);
      var capDraft = capPair[0];
      var setCapDraft = capPair[1];
      var savePair = React.useState({ status: 'idle', error: undefined });
      var saveState = savePair[0];
      var setSaveState = savePair[1];

      if (!snapshot || snapshot.status !== 'ready') return null;
      var savedRaw = snapshot.value && snapshot.value[DEPTH_CAP_FIELD];
      var saved = Number.isFinite(Number(savedRaw)) ? Math.max(0, Math.floor(Number(savedRaw))) : 0;
      var savedEnabled = saved > 0;
      var enabled = enabledDraft === undefined ? savedEnabled : enabledDraft;
      var capText = capDraft === undefined ? String(savedEnabled ? saved : DEFAULT_DEPTH_CAP) : capDraft;
      var parsed = Number(capText);
      var validCap = capText.trim() !== '' && Number.isInteger(parsed) && parsed >= MIN_DEPTH_CAP && parsed <= MAX_DEPTH_CAP;
      var desired = enabled && validCap ? parsed : 0;
      var dirty = (enabled !== savedEnabled) || (enabled && validCap && parsed !== saved);
      var writable = snapshot.writable === true;
      var saving = saveState.status === 'saving';
      var h = React.createElement;

      async function save() {
        if (!scope || typeof scope.set !== 'function' || !writable || saving || !dirty || (enabled && !validCap)) return;
        setSaveState({ status: 'saving', error: undefined });
        try {
          await scope.set(DEPTH_CAP_FIELD, desired);
          if (typeof scope.load === 'function') await scope.load();
          setEnabledDraft(undefined);
          setCapDraft(undefined);
          setSaveState({ status: 'saved', error: undefined });
        } catch (error) {
          setSaveState({ status: 'error', error: error && error.message ? error.message : String(error) });
        }
      }

      function discard() {
        setEnabledDraft(undefined);
        setCapDraft(undefined);
        setSaveState({ status: 'idle', error: undefined });
      }

      return h('ul', { style: { listStyle: 'none', margin: '0 0 12px', padding: 0 } },
        h('li', { className: 'vr-card vr-card-open' },
          h('div', { className: 'vr-body', style: { borderTop: 0, paddingTop: 8 } },
            h('label', { className: 'vr-toggle' },
              h('input', {
                type: 'checkbox',
                checked: enabled,
                disabled: !writable || saving,
                onChange: function(event) {
                  setEnabledDraft(event.target.checked === true);
                  if (event.target.checked === true && capDraft === undefined && !savedEnabled) setCapDraft(String(DEFAULT_DEPTH_CAP));
                  setSaveState({ status: 'idle', error: undefined });
                }
              }),
              h('span', null, t('depthCapTitle'))
            ),
            h('p', { className: 'vr-hint' }, t('depthCapHint')),
            enabled
              ? h('div', { className: 'vr-field' },
                  h('div', { className: 'vr-field-head' }, h('span', { className: 'vr-label' }, t('depthCapValueLabel'))),
                  h('input', {
                    className: 'vr-input',
                    type: 'number',
                    min: MIN_DEPTH_CAP,
                    max: MAX_DEPTH_CAP,
                    step: 1,
                    value: capText,
                    disabled: !writable || saving,
                    onChange: function(event) {
                      setCapDraft(event.target.value);
                      setSaveState({ status: 'idle', error: undefined });
                    }
                  }),
                  !validCap ? h('p', { className: 'vr-failed', role: 'alert' }, t('depthCapInvalid')) : null
                )
              : null,
            h('div', { className: 'vr-quickstart-actions' },
              dirty
                ? h('button', { type: 'button', className: 'vr-btn', disabled: saving, onClick: discard }, t('discard'))
                : null,
              dirty
                ? h('button', {
                    type: 'button', className: 'vr-btn vr-btn-save', disabled: !writable || saving || (enabled && !validCap),
                    onClick: function(){ void save(); }
                  }, saving ? t('saving') : t('save'))
                : null,
              saveState.status === 'saved' ? h('span', { className: 'vr-hint' }, t('depthCapSaved')) : null,
              saveState.status === 'error' ? h('span', { className: 'vr-failed' }, t('depthCapSaveFailed') + ': ' + String(saveState.error || 'unknown')) : null
            )
          )
        )
      );
    };
  }

  function makeBudgetCard(React) {
    return function VisionRouterTurnBudgetCard(props) {
      var scope = props && props.scope;
      var t = props && typeof props.t === 'function' ? props.t : function(key){ return key; };
      var subscribe = React.useMemo(function() {
        return scope && typeof scope.subscribe === 'function' ? scope.subscribe.bind(scope) : function(){ return function(){}; };
      }, [scope]);
      var getSnapshot = React.useMemo(function() {
        return scope && typeof scope.getSnapshot === 'function' ? scope.getSnapshot.bind(scope) : function(){ return undefined; };
      }, [scope]);
      var snapshot = React.useSyncExternalStore(subscribe, getSnapshot);
      var draftPair = React.useState(undefined);
      var draft = draftPair[0];
      var setDraft = draftPair[1];
      var savePair = React.useState({ status: 'idle', error: undefined });
      var saveState = savePair[0];
      var setSaveState = savePair[1];

      if (!snapshot || snapshot.status !== 'ready') return null;
      var savedRaw = snapshot.value && snapshot.value[TURN_BUDGET_FIELD];
      var saved = Number.isFinite(Number(savedRaw)) ? Number(savedRaw) : DEFAULT_TURN_BUDGET_MS;
      var text = draft === undefined ? String(saved) : draft;
      var parsed = Number(text);
      var valid = text.trim() !== '' && Number.isInteger(parsed) && (parsed === 0 || (parsed >= MIN_TURN_BUDGET_MS && parsed <= MAX_TURN_BUDGET_MS));
      var dirty = valid && parsed !== saved;
      var writable = snapshot.writable === true;
      var saving = saveState.status === 'saving';
      var h = React.createElement;

      async function save() {
        if (!scope || typeof scope.set !== 'function' || !writable || saving || !dirty) return;
        setSaveState({ status: 'saving', error: undefined });
        try {
          await scope.set(TURN_BUDGET_FIELD, parsed);
          if (typeof scope.load === 'function') await scope.load();
          setDraft(undefined);
          setSaveState({ status: 'saved', error: undefined });
        } catch (error) {
          setSaveState({ status: 'error', error: error && error.message ? error.message : String(error) });
        }
      }

      return h('ul', { style: { listStyle: 'none', margin: '0 0 12px', padding: 0 } },
        h('li', { className: 'vr-card vr-card-open' },
          h('div', { className: 'vr-body', style: { borderTop: 0, paddingTop: 8 } },
            h('div', { className: 'vr-field' },
              h('div', { className: 'vr-field-head' },
                h('span', { className: 'vr-label' }, t('visionTurnBudgetTitle'))
              ),
              h('input', {
                className: 'vr-input',
                type: 'number',
                min: 0,
                max: MAX_TURN_BUDGET_MS,
                step: 1000,
                value: text,
                disabled: !writable || saving,
                onChange: function(event) {
                  setDraft(event.target.value);
                  setSaveState({ status: 'idle', error: undefined });
                }
              }),
              h('p', { className: 'vr-hint' }, t('visionTurnBudgetHint')),
              draft !== undefined && !valid
                ? h('p', { className: 'vr-failed', role: 'alert' }, t('visionTurnBudgetInvalid'))
                : null,
              h('div', { className: 'vr-quickstart-actions' },
                draft !== undefined
                  ? h('button', {
                      type: 'button', className: 'vr-btn', disabled: saving,
                      onClick: function(){ setDraft(undefined); setSaveState({ status: 'idle', error: undefined }); }
                    }, t('discard'))
                  : null,
                dirty
                  ? h('button', {
                      type: 'button', className: 'vr-btn vr-btn-save', disabled: !writable || saving || !valid,
                      onClick: function(){ void save(); }
                    }, saving ? t('saving') : t('save'))
                  : null,
                saveState.status === 'saved' ? h('span', { className: 'vr-hint' }, t('visionTurnBudgetSaved')) : null,
                saveState.status === 'error' ? h('span', { className: 'vr-failed' }, t('visionTurnBudgetSaveFailed') + ': ' + String(saveState.error || 'unknown')) : null
              )
            )
          )
        )
      );
    };
  }

  function wrapSlots(slots, React) {
    if (!slots || (typeof slots !== 'object' && typeof slots !== 'function')) return slots;
    var DepthCapCard = makeDepthCapCard(React);
    var BudgetCard = makeBudgetCard(React);
    return new Proxy(slots, {
      get: function(target, property) {
        if (property === 'register') {
          var register = Reflect.get(target, property, target);
          if (typeof register !== 'function') return register;
          return function(options, component) {
            var args = Array.prototype.slice.call(arguments);
            if (options && options.name === 'settings.section' && options.id === SETTINGS_SECTION_ID && component) {
              var Original = component;
              args[1] = function VisionRouterSectionWithLimits(props) {
                var originalProps = Object.assign({}, props, { scope: strategyScope(props && props.scope) });
                return React.createElement(
                  React.Fragment,
                  null,
                  React.createElement(Original, originalProps),
                  React.createElement(DepthCapCard, props),
                  React.createElement(BudgetCard, props)
                );
              };
            }
            return register.apply(target, args);
          };
        }
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
  }

  function wrapContext(ctx, React) {
    if (!ctx || typeof ctx !== 'object') return ctx;
    if (contexts && contexts.has(ctx)) return contexts.get(ctx);
    var locale = wrapLocale(ctx.locale);
    var slots = wrapSlots(ctx.slots, React);
    var wrapped = new Proxy(ctx, {
      get: function(target, property) {
        if (property === 'locale') return locale;
        if (property === 'slots') return slots;
        var value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    if (contexts) contexts.set(ctx, wrapped);
    return wrapped;
  }

  function patchLoader(loader) {
    if (!loader || (typeof loader !== 'object' && typeof loader !== 'function')) return;
    if (typeof loader.load === 'function' && !loader.load.__visionRouterTurnBudget) {
      var original = loader.load;
      function load(spec) {
        if (spec && spec.id === TARGET && typeof spec.factory === 'function') {
          var factory = spec.factory;
          spec = Object.assign({}, spec, {
            factory: function(require) {
              var realReact;
              try { realReact = require('react'); } catch (_) { realReact = undefined; }
              var scopedReact = wrapReact(realReact);
              function scopedRequire(id) {
                if (id === 'react' && scopedReact) return scopedReact;
                return require(id);
              }
              var exports = factory(scopedRequire);
              var React = scopedReact || realReact;
              if (React && exports && typeof exports.apply === 'function' && !exports.apply.__visionRouterTurnBudget) {
                var apply = exports.apply;
                var wrappedApply = function(ctx) {
                  var rest = Array.prototype.slice.call(arguments, 1);
                  return apply.apply(exports, [wrapContext(ctx, React)].concat(rest));
                };
                Object.defineProperty(wrappedApply, '__visionRouterTurnBudget', { value: true });
                exports.apply = wrappedApply;
              }
              return exports;
            }
          });
        }
        return original.call(loader, spec);
      }
      Object.defineProperty(load, '__visionRouterTurnBudget', { value: true });
      loader.load = load;
    }
    if (typeof loader.create === 'function' && !loader.create.__visionRouterTurnBudget) {
      var originalCreate = loader.create;
      function create() {
        var result = originalCreate.apply(this, arguments);
        patchLoader(loader);
        return result;
      }
      Object.defineProperty(create, '__visionRouterTurnBudget', { value: true });
      loader.create = create;
    }
  }

  function install() {
    if (window.__ModuleLoader__) {
      patchLoader(window.__ModuleLoader__);
      return;
    }
    var descriptor = Object.getOwnPropertyDescriptor(window, '__ModuleLoader__');
    if (descriptor && descriptor.configurable === false) return;
    var stored;
    Object.defineProperty(window, '__ModuleLoader__', {
      configurable: true,
      enumerable: true,
      get: function(){ return stored; },
      set: function(value) {
        stored = value;
        patchLoader(value);
        Object.defineProperty(window, '__ModuleLoader__', {
          configurable: true,
          enumerable: true,
          writable: true,
          value: stored
        });
      }
    });
  }

  try { install(); } catch (_) {}
})();`

export function injectVisionTurnBudgetClientPrelude(html) {
  if (typeof html !== 'string' || html.includes(CLIENT_PRELUDE_MARK)) return html
  const script = `<script ${CLIENT_PRELUDE_MARK}>${VISION_TURN_BUDGET_CLIENT_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installVisionTurnBudgetClientPrelude(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectVisionTurnBudgetClientPrelude),
      'vision-router: turn budget client prelude',
    )
  })
}
