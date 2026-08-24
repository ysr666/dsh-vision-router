const CLIENT_PRELUDE_MARK = 'data-vision-router-wrapper-scope'

export const WRAPPER_SCOPE_CLIENT_PRELUDE = String.raw`(function(){
  'use strict';
  var TARGET = 'dsh-vision-router';
  var SETTINGS_SECTION_ID = 'vision-router';
  var contexts = typeof WeakMap === 'function' ? new WeakMap() : undefined;

  function rpcValue(body) {
    if (body && typeof body === 'object' && body.result && typeof body.result === 'object') {
      return body.result.ok === true ? body.result.value : undefined;
    }
    return body;
  }

  function patchCopy(namespace, dictionaries) {
    if (namespace !== SETTINGS_SECTION_ID || !dictionaries || typeof dictionaries !== 'object') return dictionaries;
    var next = Object.assign({}, dictionaries);
    if (next.zh && typeof next.zh === 'object') {
      next.zh = Object.assign({}, next.zh, {
        wrapperScopeTitle: '识图模式可用范围',
        wrapperScopeAutoOn: '自动模式：未单独限制的已启用模型也会提供识图模式',
        wrapperScopeAutoOff: '仅自定义：只为下方列出的 provider / model 提供识图模式',
        wrapperScopeHint: '范围策略由下方「自动创建 + 自动识图模型组」开关控制。开启时，下方行用于限制指定 provider（未列出的 provider 仍自动包装）；关闭时，下方行就是显式允许列表。模型留空 = 整个 provider。改动即时生效。',
        wrapperScopeLoading: '正在读取「设置 → 模型」目录…',
        wrapperScopeUnavailable: '暂时无法读取模型目录；已保存的范围仍会保留。',
        wrapperScopeRemoved: '（已删除或停用）',
        wrapperScopeSaved: '已保存',
        wrapperScopeSaveFailed: '保存失败',
        groupWrappers: '包装范围（高级同步入口）',
        textWrappedProviders: '包装范围'
      });
    }
    if (next.en && typeof next.en === 'object') {
      next.en = Object.assign({}, next.en, {
        wrapperScopeTitle: 'Vision mode scope',
        wrapperScopeAutoOn: 'Automatic: enabled models not explicitly limited also get Vision mode',
        wrapperScopeAutoOff: 'Custom only: Vision mode is available only for the provider/model rows below',
        wrapperScopeHint: 'The “Auto-create + Auto Vision model groups” switch below controls the policy. When it is on, rows below restrict only the listed providers while unlisted providers stay automatic. When it is off, these rows are the explicit allow-list. Leave model empty to include the whole provider. Changes apply live.',
        wrapperScopeLoading: 'Loading the Settings → Models catalog…',
        wrapperScopeUnavailable: 'The model catalog is temporarily unavailable; saved scope is preserved.',
        wrapperScopeRemoved: ' (removed or disabled)',
        wrapperScopeSaved: 'Saved',
        wrapperScopeSaveFailed: 'Save failed',
        groupWrappers: 'Wrapper scope (advanced mirror)',
        textWrappedProviders: 'Wrapper scope'
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

  function expandWrappedProviders(value) {
    var rows = [];
    (Array.isArray(value) ? value : []).forEach(function(entry) {
      if (!entry || typeof entry.provider !== 'string' || !entry.provider) return;
      var models = Array.isArray(entry.models) ? entry.models : [];
      if (models.length === 0) rows.push({ provider: entry.provider, model: '' });
      else models.forEach(function(model) {
        if (typeof model === 'string' && model) rows.push({ provider: entry.provider, model: model });
      });
    });
    return rows.length > 0 ? rows : [{ provider: '', model: '' }];
  }

  function collapseWrappedProviders(rows) {
    var merged = new Map();
    (Array.isArray(rows) ? rows : []).forEach(function(row) {
      if (!row || typeof row !== 'object') return;
      var provider = typeof row.provider === 'string' ? row.provider.trim() : '';
      var model = typeof row.model === 'string' ? row.model.trim() : '';
      if (!provider) return;
      if (!merged.has(provider)) merged.set(provider, new Set());
      var set = merged.get(provider);
      if (set === null) return;
      if (!model) merged.set(provider, null);
      else set.add(model);
    });
    return Array.from(merged.entries()).map(function(pair) {
      return { provider: pair[0], models: pair[1] === null ? [] : Array.from(pair[1]) };
    });
  }

  function canonicalWrapped(value) {
    return collapseWrappedProviders(expandWrappedProviders(value));
  }

  function jsonEqual(left, right) {
    try { return JSON.stringify(left) === JSON.stringify(right); } catch (_) { return false; }
  }

  function availableGroups(groups, snapshot) {
    var value = snapshot && snapshot.value && typeof snapshot.value === 'object' ? snapshot.value : {};
    var wrapperRoute = typeof value.wrapperRoute === 'string' && value.wrapperRoute ? value.wrapperRoute : 'deepseek-vision';
    var chainRoute = typeof value.chainRoute === 'string' && value.chainRoute ? value.chainRoute : 'vision-chain';
    return (Array.isArray(groups) ? groups : []).filter(function(group) {
      if (!group || typeof group.id !== 'string' || !group.id) return false;
      if (group.id === 'vision-http' || group.id === wrapperRoute || group.id === chainRoute) return false;
      if (group.id.endsWith('-vision')) return false;
      return true;
    });
  }

  function makeScopeCard(React) {
    return function VisionRouterWrapperScopeCard(props) {
      var scope = props && props.scope;
      var t = props && typeof props.t === 'function' ? props.t : function(key){ return key; };
      var subscribe = React.useMemo(function() {
        return scope && typeof scope.subscribe === 'function' ? scope.subscribe.bind(scope) : function(){ return function(){}; };
      }, [scope]);
      var getSnapshot = React.useMemo(function() {
        return scope && typeof scope.getSnapshot === 'function' ? scope.getSnapshot.bind(scope) : function(){ return undefined; };
      }, [scope]);
      var snapshot = React.useSyncExternalStore(subscribe, getSnapshot);
      var state = React.useState(undefined);
      var draftRows = state[0];
      var setDraftRows = state[1];
      var savePair = React.useState({ status: 'idle', error: undefined });
      var saveState = savePair[0];
      var setSaveState = savePair[1];
      var catalogPair = React.useState({ status: 'idle', groups: [] });
      var catalog = catalogPair[0];
      var setCatalog = catalogPair[1];

      React.useEffect(function() {
        var disposed = false;
        var generation = 0;
        function load() {
          var current = ++generation;
          setCatalog(function(previous) {
            return previous.status === 'ready' ? previous : { status: 'loading', groups: previous.groups || [] };
          });
          try {
            var connection = props && typeof props.getConnection === 'function' ? props.getConnection() : undefined;
            var models = connection && connection.api && connection.api.llm && connection.api.llm.models;
            if (typeof models !== 'function') {
              if (!disposed && current === generation) setCatalog({ status: 'error', groups: [] });
              return;
            }
            Promise.resolve(models.call(connection.api.llm, {})).then(function(body) {
              if (disposed || current !== generation) return;
              var value = rpcValue(body);
              setCatalog({
                status: value && Array.isArray(value.groups) ? 'ready' : 'error',
                groups: value && Array.isArray(value.groups) ? value.groups : []
              });
            }, function() {
              if (!disposed && current === generation) setCatalog({ status: 'error', groups: [] });
            });
          } catch (_) {
            if (!disposed && current === generation) setCatalog({ status: 'error', groups: [] });
          }
        }
        load();
        var stops = [];
        try {
          if (props && props.remote && typeof props.remote.$on === 'function') {
            stops.push(props.remote.$on('llm/adapters-updated', load));
            stops.push(props.remote.$on('settings/document-updated', load));
          }
        } catch (_) {}
        try {
          if (props && typeof props.subscribeConnectionReset === 'function') stops.push(props.subscribeConnectionReset(load));
        } catch (_) {}
        return function() {
          disposed = true;
          generation += 1;
          stops.forEach(function(stop){ try { if (typeof stop === 'function') stop(); } catch (_) {} });
        };
      }, [props && props.getConnection, props && props.remote, props && props.subscribeConnectionReset]);

      if (!snapshot || snapshot.status !== 'ready') return null;
      var saved = snapshot.value && typeof snapshot.value === 'object' ? snapshot.value.wrappedProviders : [];
      var rows = Array.isArray(draftRows) ? draftRows : expandWrappedProviders(saved);
      var groups = availableGroups(catalog.groups, snapshot);
      var groupById = new Map(groups.map(function(group){ return [group.id, group]; }));
      var auto = !(snapshot.value && snapshot.value.autoWrapProviders === false);
      var writable = snapshot.writable === true;
      var saving = saveState.status === 'saving';
      var dirty = !jsonEqual(collapseWrappedProviders(rows), canonicalWrapped(saved));
      var h = React.createElement;

      function providerOptions(current) {
        var nodes = [h('option', { value: '', key: '__empty' }, t('selectProvider'))];
        if (current && !groupById.has(current)) {
          nodes.push(h('option', { value: current, key: '__stale-' + current, disabled: true }, current + t('wrapperScopeRemoved')));
        }
        groups.forEach(function(group) {
          nodes.push(h('option', { value: group.id, key: group.id },
            group.name && group.name !== group.id ? group.name + ' (' + group.id + ')' : group.id));
        });
        return nodes;
      }

      function modelOptions(row) {
        var group = groupById.get(row.provider);
        var models = group && Array.isArray(group.models) ? group.models : [];
        var listed = new Set(models.map(function(model){ return model && model.id; }).filter(Boolean));
        var nodes = [h('option', { value: '', key: '__all' }, row.provider ? t('wrapAllModels') : t('pickProviderFirst'))];
        if (row.model && !listed.has(row.model)) {
          nodes.push(h('option', { value: row.model, key: '__stale-' + row.model, disabled: true }, row.model + t('wrapperScopeRemoved')));
        }
        models.forEach(function(model) {
          if (!model || typeof model.id !== 'string' || !model.id) return;
          nodes.push(h('option', { value: model.id, key: model.id },
            model.name && model.name !== model.id ? model.name + ' (' + model.id + ')' : model.id));
        });
        return nodes;
      }

      function update(index, next) {
        var copy = rows.map(function(row){ return Object.assign({}, row); });
        copy[index] = next;
        setDraftRows(copy);
        setSaveState({ status: 'idle', error: undefined });
      }

      function remove(index) {
        var copy = rows.filter(function(_row, rowIndex){ return rowIndex !== index; });
        setDraftRows(copy.length > 0 ? copy : [{ provider: '', model: '' }]);
        setSaveState({ status: 'idle', error: undefined });
      }

      async function save() {
        if (!writable || saving || !dirty || !scope || typeof scope.set !== 'function') return;
        setSaveState({ status: 'saving', error: undefined });
        try {
          var value = collapseWrappedProviders(rows);
          // Store [] explicitly instead of unsetting: an explicit empty custom
          // allow-list is different from restoring the schema default row.
          await scope.set('wrappedProviders', value);
          if (typeof scope.load === 'function') await scope.load();
          setDraftRows(undefined);
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
                h('span', { className: 'vr-label' }, t('wrapperScopeTitle')),
                h('span', { className: 'vr-badge' }, auto ? t('wrapperScopeAutoOn') : t('wrapperScopeAutoOff'))
              ),
              h('p', { className: 'vr-hint' }, t('wrapperScopeHint')),
              catalog.status === 'loading' ? h('p', { className: 'vr-hint' }, t('wrapperScopeLoading')) : null,
              catalog.status === 'error' ? h('p', { className: 'vr-hint vr-stealth-notice' }, t('wrapperScopeUnavailable')) : null,
              rows.map(function(row, index) {
                return h('div', { className: 'vr-chain-row', key: index },
                  h('select', {
                    className: 'vr-input vr-select',
                    value: row.provider || '',
                    disabled: !writable || saving,
                    onChange: function(event){ update(index, { provider: event.target.value, model: '' }); }
                  }, providerOptions(row.provider || '')),
                  h('select', {
                    className: 'vr-input vr-select',
                    value: row.model || '',
                    disabled: !writable || saving || !row.provider || !groupById.has(row.provider),
                    onChange: function(event){ update(index, { provider: row.provider, model: event.target.value }); }
                  }, modelOptions(row)),
                  h('button', {
                    type: 'button', className: 'vr-reset', disabled: !writable || saving,
                    onClick: function(){ remove(index); }
                  }, t('remove'))
                );
              }),
              h('div', { className: 'vr-quickstart-actions' },
                h('button', {
                  type: 'button', className: 'vr-btn', disabled: !writable || saving,
                  onClick: function(){ setDraftRows(rows.concat([{ provider: '', model: '' }])); setSaveState({ status: 'idle' }); }
                }, t('addWrapper')),
                dirty ? h('button', {
                  type: 'button', className: 'vr-btn', disabled: saving,
                  onClick: function(){ setDraftRows(undefined); setSaveState({ status: 'idle' }); }
                }, t('discard')) : null,
                dirty ? h('button', {
                  type: 'button', className: 'vr-btn vr-btn-save', disabled: !writable || saving,
                  onClick: function(){ void save(); }
                }, saving ? t('saving') : t('save')) : null,
                saveState.status === 'saved' ? h('span', { className: 'vr-hint' }, t('wrapperScopeSaved')) : null,
                saveState.status === 'error' ? h('span', { className: 'vr-failed' }, t('wrapperScopeSaveFailed') + ': ' + saveState.error) : null
              )
            )
          )
        )
      );
    };
  }

  function wrapSlots(slots, React) {
    if (!slots || (typeof slots !== 'object' && typeof slots !== 'function')) return slots;
    var ScopeCard = makeScopeCard(React);
    return new Proxy(slots, {
      get: function(target, property) {
        if (property === 'register') {
          var register = Reflect.get(target, property, target);
          if (typeof register !== 'function') return register;
          return function(options, component) {
            var args = Array.prototype.slice.call(arguments);
            if (options && options.name === 'settings.section' && options.id === SETTINGS_SECTION_ID && component) {
              var Original = component;
              args[1] = function VisionRouterSectionWithWrapperScope(props) {
                return React.createElement(
                  React.Fragment,
                  null,
                  React.createElement(ScopeCard, props),
                  React.createElement(Original, props)
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
    if (typeof loader.load === 'function' && !loader.load.__visionRouterWrapperScope) {
      var original = loader.load;
      function load(spec) {
        if (spec && spec.id === TARGET && typeof spec.factory === 'function') {
          var factory = spec.factory;
          spec = Object.assign({}, spec, {
            factory: function(require) {
              var exports = factory(require);
              var React;
              try { React = require('react'); } catch (_) { React = undefined; }
              if (React && exports && typeof exports.apply === 'function' && !exports.apply.__visionRouterWrapperScope) {
                var apply = exports.apply;
                var wrappedApply = function(ctx) {
                  var rest = Array.prototype.slice.call(arguments, 1);
                  return apply.apply(exports, [wrapContext(ctx, React)].concat(rest));
                };
                Object.defineProperty(wrappedApply, '__visionRouterWrapperScope', { value: true });
                exports.apply = wrappedApply;
              }
              return exports;
            }
          });
        }
        return original.call(loader, spec);
      }
      Object.defineProperty(load, '__visionRouterWrapperScope', { value: true });
      loader.load = load;
    }
    if (typeof loader.create === 'function' && !loader.create.__visionRouterWrapperScope) {
      var originalCreate = loader.create;
      function create() {
        var result = originalCreate.apply(this, arguments);
        patchLoader(loader);
        return result;
      }
      Object.defineProperty(create, '__visionRouterWrapperScope', { value: true });
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

export function injectWrapperScopeClientPrelude(html) {
  if (typeof html !== 'string' || html.includes(CLIENT_PRELUDE_MARK)) return html
  const script = `<script ${CLIENT_PRELUDE_MARK}>${WRAPPER_SCOPE_CLIENT_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installWrapperScopeClientPrelude(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectWrapperScopeClientPrelude),
      'vision-router: wrapper scope client prelude',
    )
  })
}
