import { LIVE_MODEL_CLIENT_PRELUDE } from './live-model-client-prelude.js'

const CLIENT_PRELUDE_MARK = 'data-vision-router-live-models'
const MERGE_START = '  function mergeCatalog(body, snapshot, providerDirectoryBody) {'
const MERGE_END = '\n\n  function createLiveClient() {'

const STRICT_MERGE_CATALOG = String.raw`  function mergeCatalog(body, snapshot, providerDirectoryBody) {
    var value = rpcValue(body);
    if (!value || typeof value !== 'object') return body;
    var originalGroups = Array.isArray(value.groups) ? value.groups : [];
    var groups = originalGroups.map(function(group) {
      if (!group || typeof group !== 'object') return group;
      return Object.assign({}, group, { models: Array.isArray(group.models) ? group.models.slice() : [] });
    });
    var groupByProvider = new Map();
    var hasEnumeratedModels = new Set();
    groups.forEach(function(group) {
      if (!group || typeof group.id !== 'string' || !group.id) return;
      groupByProvider.set(group.id, group);
      if (Array.isArray(group.models) && group.models.length > 0) hasEnumeratedModels.add(group.id);
    });

    // Live /models discovery remains additive inside an actually active DSH
    // provider. The provider directory is the ownership fence: discovery may
    // reveal new model ids for that provider, but it may never recreate a
    // provider the user removed. When the directory is temporarily unavailable,
    // an existing llm.models group is sufficient fail-soft evidence of presence.
    var providerValue = rpcValue(providerDirectoryBody);
    var directoryKnown = !!providerValue && Array.isArray(providerValue.providers);
    var activeProviders = activeProviderDirectory(providerDirectoryBody);
    var activeProviderIds = new Set(activeProviders.map(function(entry){ return entry.provider; }));
    var liveByProvider = new Map();
    cleanProviders(snapshot).forEach(function(live) {
      if (!live || typeof live.provider !== 'string' || !live.provider || !Array.isArray(live.models)) return;
      liveByProvider.set(live.provider, live);
    });

    function mergeLiveModels(provider, group) {
      if (!group) return false;
      if (directoryKnown && !activeProviderIds.has(provider)) return false;
      var live = liveByProvider.get(provider);
      if (!live || !Array.isArray(live.models) || live.models.length === 0) return false;
      // A stale cache can still fill an otherwise empty, known provider group,
      // but it cannot expand a non-empty DSH catalog with old endpoint ids.
      if (live.stale === true && hasEnumeratedModels.has(provider)) return false;
      var seen = new Set((Array.isArray(group.models) ? group.models : []).map(function(model){ return model && model.id; }).filter(Boolean));
      var changed = false;
      live.models.forEach(function(model) {
        if (!model || typeof model.id !== 'string' || !model.id || seen.has(model.id)) return;
        seen.add(model.id);
        changed = true;
        group.models.push({
          provider: provider,
          id: model.id,
          name: typeof model.name === 'string' && model.name ? model.name : model.id,
          visionRouterLiveDiscovered: true
        });
      });
      if (group.models.length > 0) hasEnumeratedModels.add(provider);
      return changed;
    }

    // Existing DSH groups may receive fresh endpoint-discovered model ids. This
    // is the automatic-discovery behavior Vision Router historically exposed.
    groups.forEach(function(group) {
      if (!group || typeof group.id !== 'string' || !group.id) return;
      mergeLiveModels(group.id, group);
    });

    activeProviders.forEach(function(entry) {
      var provider = entry.provider;
      var group = groupByProvider.get(provider);
      if (!group) {
        group = {
          id: provider,
          name: typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : provider,
          models: [],
          visionRouterProviderDirectory: true
        };
        groupByProvider.set(provider, group);
        groups.push(group);
      } else if ((!group.name || group.name === group.id) && typeof entry.displayName === 'string' && entry.displayName) {
        group.name = entry.displayName;
      }

      mergeLiveModels(provider, group);

      var seen = new Set((Array.isArray(group.models) ? group.models : []).map(function(model){ return model && model.id; }).filter(Boolean));
      manualModelsFor(provider).forEach(function(model) {
        if (seen.has(model.id)) return;
        seen.add(model.id);
        group.models.push(model);
      });

      // Provider presence and model enumeration are separate DSH contracts.
      // Keep an active provider selectable even when both llm.models and live
      // endpoint discovery cannot enumerate its accepted model ids.
      if (!hasEnumeratedModels.has(provider) && !seen.has(MANUAL_MODEL_ID)) {
        group.models.push({
          provider: provider,
          id: MANUAL_MODEL_ID,
          name: MANUAL_MODEL_LABEL,
          visionRouterManualEntry: true
        });
      }
    });

    return replaceCatalogValue(body, Object.assign({}, value, { groups: groups }));
  }`

function replaceMergeCatalog(source) {
  const start = source.indexOf(MERGE_START)
  const end = source.indexOf(MERGE_END, start)
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('dsh-vision-router: live model prelude mergeCatalog boundary changed')
  }
  return source.slice(0, start) + STRICT_MERGE_CATALOG + source.slice(end)
}

export const STRICT_LIVE_MODEL_CLIENT_PRELUDE = replaceMergeCatalog(LIVE_MODEL_CLIENT_PRELUDE)

export function injectStrictLiveModelClientPrelude(html) {
  if (typeof html !== 'string' || html.includes(CLIENT_PRELUDE_MARK)) return html
  const script = `<script ${CLIENT_PRELUDE_MARK}>${STRICT_LIVE_MODEL_CLIENT_PRELUDE.replace(/<\/script/gi, '<\\/script')}</script>`
  const closeHead = html.indexOf('</head>')
  if (closeHead !== -1) return `${html.slice(0, closeHead)}${script}${html.slice(closeHead)}`
  return `${html}${script}`
}

export function installStrictLiveModelClientPrelude(ctx) {
  ctx?.inject?.(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.tapIndex(injectStrictLiveModelClientPrelude),
      'vision-router: strict live model client prelude',
    )
  })
}
