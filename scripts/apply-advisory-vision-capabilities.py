from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path):
    return (ROOT / path).read_text(encoding='utf-8')


def write(path, text):
    (ROOT / path).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    a = text.find(start)
    if a < 0:
        raise RuntimeError(f'{label}: start marker not found')
    b = text.find(end, a + len(start))
    if b < 0:
        raise RuntimeError(f'{label}: end marker not found')
    return text[:a] + replacement + text[b:]


def delete_between(text, start, end, label):
    a = text.find(start)
    if a < 0:
        raise RuntimeError(f'{label}: start marker not found')
    b = text.find(end, a + len(start))
    if b < 0:
        raise RuntimeError(f'{label}: end marker not found')
    return text[:a] + text[b:]


# ── server/runtime ──────────────────────────────────────────────────────────
path = 'index.js'
text = read(path)

capability_fn = '''export function decideVisionBackendCapability(info, provider, model, extraVisionModels) {
  const inputModalities = Array.isArray(info && info.inputModalities)
    ? info.inputModalities.filter((item) => typeof item === 'string')
    : []
  const modelId = String(model ?? '').trim()
  const providerId = String(provider ?? '').trim()
  const extras = Array.isArray(extraVisionModels)
    ? extraVisionModels.map((entry) => String(entry ?? '').trim()).filter((entry) => entry !== '')
    : []
  const forced =
    modelId !== '' &&
    extras.some((entry) => entry === modelId || (providerId !== '' && entry === `${providerId}/${modelId}`))

  // Capability metadata is ADVISORY. A user-selected generative model is
  // allowed to prove itself by an actual adapter call even when DSH omitted
  // image metadata or explicitly reports text-only input. The only hard gate
  // here is structural: endpoints that cannot produce an assistant answer
  // (embedding/reranker) are never valid vision backends.
  if (forced) {
    return {
      image: true,
      attemptable: true,
      inputModalities: [...new Set([...inputModalities, 'image'])],
      inferred: 'override',
      reason: undefined,
    }
  }
  if (modelId !== '' && looksLikeNonGenerativeVisionModel(modelId)) {
    return {
      image: false,
      attemptable: false,
      inputModalities,
      inferred: false,
      reason: 'model name indicates an embedding/reranker endpoint, not a generative vision backend',
    }
  }
  if (inputModalities.includes('image')) {
    return { image: true, attemptable: true, inputModalities, inferred: false, reason: undefined }
  }
  if (modelId !== '' && looksLikeVisionModel(modelId)) {
    return {
      image: true,
      attemptable: true,
      inputModalities: [...new Set([...inputModalities, 'image'])],
      inferred: 'name',
      reason: undefined,
    }
  }
  return {
    image: false,
    attemptable: true,
    inputModalities,
    inferred: false,
    reason:
      inputModalities.length > 0
        ? 'model metadata declares no image input'
        : 'model metadata does not declare image input',
  }
}

'''
text = replace_between(
    text,
    'export function decideVisionBackendCapability(info, provider, model, extraVisionModels) {',
    '/**\n * Resolve transport facts for the direct channel compatibility bridge.',
    capability_fn,
    'replace decideVisionBackendCapability',
)

transport_end = '''  return {
    baseURL: firstString(
      resolvedModel && resolvedModel.baseUrl,
      rawProfile && rawProfile.baseURL,
      resolvedProfile && resolvedProfile.baseURL,
      resolvedProfile && resolvedProfile.piProvider && resolvedProfile.piProvider.baseUrl,
    ),
    api: firstString(
      resolvedModel && resolvedModel.api,
      rawProfile && rawProfile.api,
      resolvedProfile && resolvedProfile.api,
    ),
    apiKeyEnv: firstString(
      rawProfile && rawProfile.apiKeyEnv,
      resolvedProfile && resolvedProfile.apiKeyEnv,
    ),
  }
}
'''
text = replace_once(
    text,
    transport_end,
    transport_end + '''
/** True only for a transport we can safely send through fetch + Chat Completions. */
export function isOpenAIHttpBridgeTransport(transport) {
  if (!transport || transport.api !== 'openai-completions' || typeof transport.baseURL !== 'string') {
    return false
  }
  try {
    const url = new URL(transport.baseURL)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
''',
    'add HTTP bridge transport guard',
)

resolve_capability = '''  const resolveVisionBackendCapability = async (provider, model) => {
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      return { image: false, attemptable: false, inputModalities: [], reason: 'missing provider/model' }
    }
    if (provider !== HTTP_ROUTE && isGeneratedVisionWrapperRoute(provider)) {
      return {
        image: false,
        attemptable: false,
        inputModalities: [],
        reason: 'generated auto-vision wrapper, not a vision backend',
      }
    }
    if (!adapterAvailable(ctx.llm, provider)) {
      return {
        image: false,
        attemptable: false,
        inputModalities: [],
        reason: 'provider adapter is not registered',
      }
    }
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      return decideVisionBackendCapability(info, provider, model, current().extraVisionModels)
    } catch (error) {
      // Custom/WebSocket/private adapters can be perfectly callable while
      // their model metadata is incomplete or not resolvable. Preserve the
      // structural decision and surface the lookup failure only as advisory
      // diagnostics; the real adapter call is the source of truth.
      const fallback = decideVisionBackendCapability(undefined, provider, model, current().extraVisionModels)
      if (!fallback.image) {
        fallback.reason = `capability metadata unavailable: ${error && error.message ? error.message : String(error)}`
      }
      return fallback
    }
  }

'''
text = replace_between(
    text,
    '  const resolveVisionBackendCapability = async (provider, model) => {',
    '  // ── direct OpenAI-compatible bridge for undeclared vision channels',
    resolve_capability,
    'replace resolveVisionBackendCapability',
)

old_bridge_gate = '''    if (!transport.baseURL) {
      return { ok: false, reason: 'no resolved channel baseURL', rawProfile, resolvedProfile, transport }
    }
    // callOpenAICompatible speaks Chat Completions. Never send another
    // provider protocol through this bridge just because its name looks visual.
    if (transport.api !== 'openai-completions') {
      return {
        ok: false,
        reason: `channel protocol ${transport.api || 'unknown'} is not OpenAI Chat Completions`,
        rawProfile,
        resolvedProfile,
        transport,
      }
    }
    return { ok: true, rawProfile, resolvedProfile, transport }
'''
new_bridge_gate = '''    if (!transport.baseURL) {
      return { ok: false, reason: 'no resolved channel baseURL', rawProfile, resolvedProfile, transport }
    }
    // This compatibility bridge is deliberately transport-specific. The
    // normal path always delegates to DSH's registered adapter, which may be
    // HTTP, WebSocket, RPC or a private protocol. Only a positively identified
    // http(s) OpenAI Chat Completions endpoint may bypass it.
    if (!isOpenAIHttpBridgeTransport(transport)) {
      return {
        ok: false,
        reason:
          `channel transport ${transport.api || 'unknown'} @ ${transport.baseURL || 'unknown'} ` +
          'is not an http(s) OpenAI Chat Completions endpoint',
        rawProfile,
        resolvedProfile,
        transport,
      }
    }
    return { ok: true, rawProfile, resolvedProfile, transport }
'''
text = replace_once(text, old_bridge_gate, new_bridge_gate, 'guard channel bridge by protocol + scheme')

call_pair_old = '''  /** Shared single-answer dispatch: corrected route first, harness path otherwise. */
  const callVisionPair = async (pair, messages, options = {}) => {
    const corrected = await correctedVisionAnswer(pair, messages, options)
    if (corrected !== undefined) return corrected
    return visionAnswer(ctx.llm, {
      provider: pair.provider,
      model: pair.model,
      messages,
      maxTokens: options.maxTokens ?? 4096,
      signal: options.signal,
    })
  }

'''
call_pair_new = call_pair_old + '''  const configuredVisionPairKeys = () =>
    new Set(
      pairs()
        .filter((pair) => pair && pair.provider !== HTTP_ROUTE)
        .map((pair) => `${pair.provider}/${pair.model}`),
    )

  const mayUseDirectChannelBridge = (pair, capability, classification) => {
    if (!pair || !classification) return false
    const kind = classification.kind
    if (
      kind !== VISION_FAILURE_KINDS.INVALID_REQUEST &&
      kind !== VISION_FAILURE_KINDS.NETWORK &&
      kind !== VISION_FAILURE_KINDS.OTHER
    ) return false
    // Explicit selection is permission to TRY an undeclared model. Inferred /
    // manual-override backends keep the legacy bridge behavior. Transport is
    // still fail-closed: WebSocket/private adapters never get converted to
    // HTTP because channelBridgePlan() must positively identify http(s) +
    // OpenAI Chat Completions before a direct request is made.
    if (!configuredVisionPairKeys().has(`${pair.provider}/${pair.model}`) && !(capability && capability.inferred)) {
      return false
    }
    return channelBridgePlan(pair.provider, pair.model).ok === true
  }

  const callVisionPairWithOptionalBridge = async (pair, messages, options = {}) => {
    try {
      return await callVisionPair(pair, messages, options)
    } catch (error) {
      const classification = classifyVisionFailure(error)
      const capability =
        options.capability ?? (await resolveVisionBackendCapability(pair.provider, pair.model))
      if (
        mayUseDirectChannelBridge(pair, capability, classification) &&
        Array.isArray(options.bridgeBlocks) &&
        typeof options.bridgeInstruction === 'string'
      ) {
        return directChannelVisionAnswer(
          pair.provider,
          pair.model,
          options.bridgeBlocks,
          options.bridgeInstruction,
          options.signal,
        )
      }
      throw error
    }
  }

'''
text = replace_once(text, call_pair_old, call_pair_new, 'add adapter-first optional HTTP bridge')

text = replace_once(
    text,
    "      if (provider !== HTTP_ROUTE && isGeneratedVisionWrapperRoute(provider)) continue\n",
    "",
    'include structural wrapper diagnostics in capability map',
)

resolve_pairs = '''  // Build the tool-side adapter chain. Explicit rows are user intent: every
  // structurally callable generative backend gets a real adapter attempt even
  // when DSH does not declare image input. Auto-discovery remains conservative
  // and only appends models positively identified as visual. This avoids
  // silently trying every text model while making custom providers reliable.
  const resolveToolVisionPairs = async () => {
    const out = []
    const seen = new Set()
    const add = (provider, model) => {
      const key = `${provider}/${model}`
      if (seen.has(key)) return
      seen.add(key)
      out.push({ provider, model })
    }

    for (const pair of pairs()) {
      if (!pair || pair.provider === HTTP_ROUTE) continue
      if (!adapterAvailable(ctx.llm, pair.provider)) continue
      const capability = await resolveVisionBackendCapability(pair.provider, pair.model)
      if (capability.attemptable !== false) add(pair.provider, pair.model)
    }

    const capabilities = await collectVisionBackendCapabilities()
    for (const [provider, models] of Object.entries(capabilities)) {
      if (provider === HTTP_ROUTE || ownRoutes().has(provider)) continue
      for (const [model, capability] of Object.entries(models ?? {})) {
        if (capability && capability.attemptable !== false && capability.image) add(provider, model)
      }
    }
    return out
  }

'''
text = replace_between(
    text,
    '  // Build the tool-side adapter chain from real image-capable models already',
    '  // ── vision chain route: fallback under our own control',
    resolve_pairs,
    'replace resolveToolVisionPairs',
)

old_chain_list = '''      async listModels() {
        const entries = []
        for (const pair of pairs()) {
          const capability = await resolveVisionBackendCapability(pair.provider, pair.model)
          if (!capability.image) continue
          entries.push({
            provider: chainRoute(),
            id: `${pair.provider}/${pair.model}`,
            name: `${pair.provider}/${pair.model}`,
            inputModalities: ['text', 'image'],
          })
        }
        return entries
      },
'''
new_chain_list = '''      async listModels() {
        const entries = []
        for (const pair of pairs()) {
          if (!adapterAvailable(ctx.llm, pair.provider)) continue
          const capability = await resolveVisionBackendCapability(pair.provider, pair.model)
          if (capability.attemptable === false) continue
          entries.push({
            provider: chainRoute(),
            id: `${pair.provider}/${pair.model}`,
            name: `${pair.provider}/${pair.model}`,
            inputModalities: ['text', 'image'],
          })
        }
        return entries
      },
'''
text = replace_once(text, old_chain_list, new_chain_list, 'relax chain listModels gate')

old_chain_gate = '''          const capability = await resolveVisionBackendCapability(pair.provider, pair.model)
          if (!capability.image) {
            failures.push(
              `${pair.provider}/${pair.model}: not an image-capable backend (${capability.reason ?? 'unknown capability'})`,
            )
            ctx.logger?.warn(
              'vision-router: chain skips %s/%s (not image-capable: %s)',
              pair.provider,
              pair.model,
              capability.reason ?? 'unknown capability',
            )
            continue
          }
'''
new_chain_gate = '''          const capability = await resolveVisionBackendCapability(pair.provider, pair.model)
          if (capability.attemptable === false) {
            failures.push(
              `${pair.provider}/${pair.model}: structurally unavailable (${capability.reason ?? 'unknown reason'})`,
            )
            ctx.logger?.warn(
              'vision-router: chain skips %s/%s (structurally unavailable: %s)',
              pair.provider,
              pair.model,
              capability.reason ?? 'unknown reason',
            )
            continue
          }
          if (!capability.image) {
            ctx.logger?.info(
              'vision-router: chain tries %s/%s despite advisory image capability (%s)',
              pair.provider,
              pair.model,
              capability.reason ?? 'not declared',
            )
          }
'''
text = replace_once(text, old_chain_gate, new_chain_gate, 'relax chain runtime capability gate')

old_rejected = '''          const capability = await resolveVisionBackendCapability(pair.provider, pair.model)
          if (!capability.image) {
            rejectedPairs.push(
              `${pair.provider}/${pair.model}: not an image-capable backend (${capability.reason ?? 'unknown capability'})`,
            )
          }
'''
new_rejected = '''          const capability = await resolveVisionBackendCapability(pair.provider, pair.model)
          if (capability.attemptable === false) {
            rejectedPairs.push(
              `${pair.provider}/${pair.model}: structurally unavailable (${capability.reason ?? 'unknown reason'})`,
            )
          }
'''
text = replace_once(text, old_rejected, new_rejected, 'relax vision_describe rejected pairs')

old_describe_call = '''            let text = await callVisionPair(pair, messages, { maxTokens: 4096, signal })
'''
new_describe_call = '''            const capability = await resolveVisionBackendCapability(pair.provider, pair.model)
            let text = await callVisionPairWithOptionalBridge(pair, messages, {
              maxTokens: 4096,
              signal,
              capability,
              bridgeBlocks: blocks,
              bridgeInstruction: promptText,
            })
'''
text = replace_once(text, old_describe_call, new_describe_call, 'bridge vision_describe initial adapter failure')

old_describe_retry = '''                  text = await callVisionPair(pair, messages, { maxTokens: 4096, signal })
'''
new_describe_retry = '''                  text = await callVisionPairWithOptionalBridge(pair, messages, {
                    maxTokens: 4096,
                    signal,
                    capability,
                    bridgeBlocks: blocks,
                    bridgeInstruction:
                      promptText + '\\n\\nThat output was not valid JSON. Respond with ONLY a valid JSON object now.',
                  })
'''
text = replace_once(text, old_describe_retry, new_describe_retry, 'bridge vision_describe JSON retry')

old_answer_cap = '''        if (!capability.image) {
          errors.push(
            `${pair.provider}/${pair.model}: not an image-capable backend (${capability.reason ?? 'unknown capability'})`,
          )
        }
'''
new_answer_cap = '''        if (capability.attemptable === false) {
          errors.push(
            `${pair.provider}/${pair.model}: structurally unavailable (${capability.reason ?? 'unknown reason'})`,
          )
        }
'''
text = replace_once(text, old_answer_cap, new_answer_cap, 'relax answerVision capability gate')

old_answer_try = '''          const text = await callVisionPair(
            pair,
            [{ role: 'user', content: [block, { type: 'text', text: instruction }] }],
            {
              maxTokens: 4096,
              signal: combineSignals(deadline.signal(), AbortSignal.timeout(timeoutMs())),
            },
          )
'''
new_answer_try = '''          const text = await callVisionPairWithOptionalBridge(
            pair,
            [{ role: 'user', content: [block, { type: 'text', text: instruction }] }],
            {
              maxTokens: 4096,
              signal: combineSignals(deadline.signal(), AbortSignal.timeout(timeoutMs())),
              capability: pairCapability,
              bridgeBlocks: [block],
              bridgeInstruction: instruction,
            },
          )
'''
text = replace_once(text, old_answer_try, new_answer_try, 'use adapter-first resilient answerVision call')

text = delete_between(
    text,
    '          // Channels whose catalog does not declare image input reject images\n',
    '          recordFailure(pairKey, classification, error && error.message ? error.message : String(error))\n',
    'remove duplicate answerVision direct bridge',
)

old_probe = '''        for (const pair of pairs()) {
          const capability = await resolveVisionBackendCapability(pair.provider, pair.model)
          if (capability.image) {
            first = pair
            break
          }
        }
'''
new_probe = '''        for (const pair of pairs()) {
          if (!pair) continue
          if (pair.provider !== HTTP_ROUTE && !adapterAvailable(ctx.llm, pair.provider)) continue
          const capability = await resolveVisionBackendCapability(pair.provider, pair.model)
          if (capability.attemptable !== false) {
            first = pair
            break
          }
        }
'''
text = replace_once(text, old_probe, new_probe, 'test connection uses structural eligibility')

write(path, text)


# ── settings UI ─────────────────────────────────────────────────────────────
path = 'lib/client.js'
text = read(path)

# Exact single-line copy replacements. No regex/backtracking.
copy_replacements = [
    (
        "      guideChainBody: '上面的每一行都是你自己的视觉模型，从上到下依次尝试；可以全部留空。内置 OVH 免费链固定在最后自动兜底。这里不会修改聊天页右下角的会话/文字模型。选好后点击页面底部「保存」。',",
        "      guideChainBody: '上面的每一行都是你选择的视觉后端候选，从上到下依次实际尝试；可以全部留空。DSH 的图片能力声明现在只作提示，不再决定能不能选。内置 OVH 免费链固定在最后自动兜底。选好后点击页面底部「保存」。',",
        'zh guide chain copy',
    ),
    (
        "      chainHint: '上面每一行只选择一个你在「设置 → 模型」中已经配置的用户视觉模型（声明支持图片、按名称识别、或在下方「额外视觉模型」里手动指定）；从上到下依次尝试。可以一行都不填，下方内置 OVH 免费兜底仍会工作。',",
        "      chainHint: '每行可选择「设置 → 模型」中的任意可调用生成式模型；DSH 的图片能力声明只用于提示。调用时优先走该供应商已注册的 DSH adapter（包括 WebSocket / RPC / 私有协议），失败自动尝试下一行；只有明确识别为 http(s) OpenAI Chat Completions 时才会尝试 HTTP 直连兼容兜底。',",
        'zh chain hint',
    ),
    (
        "      visionCapsLoading: '正在验证哪些模型真正支持图片输入…',",
        "      visionCapsLoading: '正在读取模型图片能力声明（仅用于提示，不影响可选模型）…',",
        'zh capability loading',
    ),
    (
        "      visionCapsError: '视觉能力元数据暂时不可用；为防止误选，暂不提供用户视觉模型下拉。内置 OVH 免费兜底仍可用。',",
        "      visionCapsError: '视觉能力元数据暂时不可用；模型仍可选择，实际可用性将由供应商已注册的 DSH adapter 在调用时验证。',",
        'zh capability error',
    ),
    (
        "      visionCapsFiltered: '视觉后端下拉只显示声明支持图片、或按名称/手动指定被识别为视觉的模型。',",
        "      visionCapsFiltered: '模型能力声明只用于提示，不再作为准入条件；未声明图片能力或标成仅文本的生成式模型也可选择，调用失败会自动回退。',",
        'zh capability policy',
    ),
    (
        "      chainInvalidCurrent: '当前保存的视觉后端不支持图片或无法验证，已从下拉列表隐藏，运行时也会跳过：',",
        "      chainInvalidCurrent: '当前保存的后端已不在可调用模型目录中，或属于非生成式/递归路由，运行时会跳过：',",
        'zh invalid current',
    ),
    (
        "      groupVisionOverrides: '视觉模型识别',",
        "      groupVisionOverrides: '视觉能力标记（可选）',",
        'zh overrides heading',
    ),
    (
        "      extraVisionModelsLabel: '额外视觉模型（强制按视觉模型处理）',",
        "      extraVisionModelsLabel: '额外视觉模型（仅覆盖能力标记，可选）',",
        'zh override label',
    ),
    (
        "      textProvidersHint: '每行一个真正支持图片输入的「provider/model」，从上到下失败回退；不要填写纯文本模型。留空清除用户覆盖。',",
        "      textProvidersHint: '每行一个可调用生成式「provider/model」，从上到下失败回退。图片能力声明只作提示；运行时先走 DSH adapter，失败自动回退。留空清除用户覆盖。',",
        'zh free-text backend hint',
    ),
    (
        "      guideChainBody: 'Each row above is one of your own vision models, tried top to bottom; you may leave them all empty. The built-in OVH chain remains the automatic final fallback. This does not change the session/text model in the lower-right chat selector. Click “Save” after choosing.',",
        "      guideChainBody: 'Each row is a vision-backend candidate you chose and will be tried in order. Rows may all stay empty. DSH image-capability metadata is advisory only and no longer decides what you may select. The built-in OVH free chain remains the final fallback. Save when done.',",
        'en guide chain copy',
    ),
    (
        "      chainHint: 'Each row selects one user vision model already configured under Settings → Models (declaring image input, recognized by name, or listed in “Extra vision models” below). Rows are tried top to bottom. You may leave them all empty; the built-in OVH fallback below still works.',",
        "      chainHint: 'Each row may select any callable generative model from Settings → Models; DSH image-capability metadata is advisory only. Calls always go through the registered DSH adapter first (including WebSocket, RPC, or private transports), then fail over to the next row. The direct HTTP compatibility bridge is considered only for a positively identified http(s) OpenAI Chat Completions endpoint.',",
        'en chain hint',
    ),
    (
        "      visionCapsLoading: 'Checking which models genuinely accept image input…',",
        "      visionCapsLoading: 'Reading model image-capability metadata (advisory only; it does not hide selectable models)…',",
        'en capability loading',
    ),
    (
        "      visionCapsError: 'Vision capability metadata is unavailable; user vision-model choices are hidden to prevent bad selections. The built-in OVH fallback still works.',",
        "      visionCapsError: 'Vision capability metadata is temporarily unavailable; models remain selectable and the registered DSH adapter will verify actual support when called.',",
        'en capability error',
    ),
    (
        "      visionCapsFiltered: 'The vision-backend dropdown shows only models that declare image input or are recognized as vision models by name / manual override.',",
        "      visionCapsFiltered: 'Capability metadata is advisory, not an admission gate. Generative models with undeclared or text-only metadata remain selectable and failures automatically fall through.',",
        'en capability policy',
    ),
    (
        "      chainInvalidCurrent: 'This saved vision backend does not support images or could not be verified. It is hidden from the dropdown and skipped at runtime: ',",
        "      chainInvalidCurrent: 'This saved backend is no longer callable, or is a non-generative/recursive route, so runtime will skip it: ',",
        'en invalid current',
    ),
    (
        "      groupVisionOverrides: 'Vision model recognition',",
        "      groupVisionOverrides: 'Vision capability labels (optional)',",
        'en overrides heading',
    ),
    (
        "      extraVisionModelsLabel: 'Extra vision models (force-treat as vision)',",
        "      extraVisionModelsLabel: 'Extra vision models (capability-label override, optional)',",
        'en override label',
    ),
    (
        "      textProvidersHint: 'One genuinely image-capable \"provider/model\" per line, top-down failover. Do not put text-only models here. Empty clears the override.',",
        "      textProvidersHint: 'One callable generative \"provider/model\" per line, top-down failover. Image-capability metadata is advisory; the registered DSH adapter is tried first and failures fall through. Empty clears the override.',",
        'en free-text backend hint',
    ),
]
for old, new, label in copy_replacements:
    text = replace_once(text, old, new, label)

text = replace_between(
    text,
    "      extraVisionModelsHint:\n        '下拉里列出的是能力过滤时被排除的模型",
    "      groupRoutes: '路由名',",
    '''      extraVisionModelsHint:
        '这个设置不再用于“解锁”下拉或允许调用；所有可调用生成式模型本来就能被选择。' +
        '只有当你希望把某个未声明图片能力的模型明确标记为视觉模型时才需要填写。' +
        '实际调用仍优先走 DSH adapter；只有明确的 http(s) OpenAI Chat Completions 渠道才可能使用直连兼容兜底。',
''',
    'replace zh extraVisionModels hint',
)
text = replace_between(
    text,
    "      extraVisionModelsHint:\n        'The dropdown lists the models the capability filter excluded",
    "      groupRoutes: 'Route names',",
    '''      extraVisionModelsHint:
        'This setting no longer unlocks the picker or admission: every callable generative model is selectable already. ' +
        'Use it only when you want to explicitly label an undeclared model as visual. ' +
        'Runtime still tries the DSH adapter first; only a confirmed http(s) OpenAI Chat Completions channel may use the direct compatibility bridge.',
''',
    'replace en extraVisionModels hint',
)

zh_marker = "      visionCapsFiltered: '模型能力声明只用于提示，不再作为准入条件；未声明图片能力或标成仅文本的生成式模型也可选择，调用失败会自动回退。',\n"
zh_warnings = (
    "      visionCapabilityUndeclaredWarning: '⚠️ DSH 未声明此模型支持图片输入。Vision Router 会先通过该供应商已注册的适配器实际尝试；失败后自动切换到下一视觉后端。',\n"
    "      visionCapabilityTextOnlyWarning: '⚠️ DSH 将此模型标记为仅文本。仍可尝试；如果底层实际上不支持图片，调用失败后会自动切换到下一视觉后端。',\n"
    "      visionCapabilityUnknownWarning: '⚠️ 无法读取此模型的图片能力声明。仍会优先通过 DSH 已注册的适配器实际尝试；失败后自动回退。',\n"
)
text = replace_once(text, zh_marker, zh_marker + zh_warnings, 'insert zh capability warnings')

en_marker = "      visionCapsFiltered: 'Capability metadata is advisory, not an admission gate. Generative models with undeclared or text-only metadata remain selectable and failures automatically fall through.',\n"
en_warnings = (
    "      visionCapabilityUndeclaredWarning: '⚠️ DSH does not declare image input for this model. Vision Router will try the provider\\'s registered adapter first and automatically fall through on failure.',\n"
    "      visionCapabilityTextOnlyWarning: '⚠️ DSH marks this model as text-only. You may still try it; if the underlying model rejects images, Vision Router automatically falls through.',\n"
    "      visionCapabilityUnknownWarning: '⚠️ Image-capability metadata is unavailable for this model. Vision Router will still try the registered DSH adapter first and fall through on failure.',\n"
)
text = replace_once(text, en_marker, en_marker + en_warnings, 'insert en capability warnings')

filter_block = '''    function filterVisionBackendGroups(groups, capabilities) {
      const caps = capabilities && typeof capabilities === 'object' ? capabilities : {}
      return (Array.isArray(groups) ? groups : [])
        .filter((group) => group && typeof group.id === 'string' && group.id !== 'vision-http')
        .map((group) => {
          const models = (Array.isArray(group.models) ? group.models : []).filter((model) => {
            if (!model || typeof model.id !== 'string' || model.id === '') return false
            const capability = caps[group.id] && caps[group.id][model.id]
            // Missing/negative image metadata is advisory. Only a positive
            // structural rejection (non-generative endpoint, generated wrapper,
            // missing adapter) removes an entry from the picker.
            return !(capability && capability.attemptable === false)
          })
          return { ...group, models }
        })
        .filter((group) => group.models.length > 0)
    }

    // Retained for the optional capability-label override editor. These models
    // are no longer hidden from the backend chain; they merely lack a positive
    // image declaration/inference and can be explicitly relabelled by experts.
    function collectFilteredVisionBackends(groups, capabilities) {
      const caps = capabilities && typeof capabilities === 'object' ? capabilities : {}
      const uncertain = []
      for (const group of filterVisionBackendGroups(groups, caps)) {
        for (const model of Array.isArray(group.models) ? group.models : []) {
          const capability = caps[group.id] && caps[group.id][model.id]
          if (capability && capability.attemptable === false) continue
          if (capability && capability.image === true) continue
          uncertain.push({
            provider: group.id,
            model: model.id,
            reason: capability && typeof capability.reason === 'string' ? capability.reason : undefined,
            missingImageDeclaration:
              !!capability && capability.reason === 'model metadata does not declare image input',
          })
        }
      }
      return uncertain
    }

    function visionCapabilityWarningKey(capability, status) {
      if (status === 'loading' || status === 'idle') return undefined
      if (status === 'error' || !capability) return 'visionCapabilityUnknownWarning'
      if (capability.attemptable === false || capability.image === true) return undefined
      const modalities = Array.isArray(capability.inputModalities) ? capability.inputModalities : []
      return modalities.length > 0 && !modalities.includes('image')
        ? 'visionCapabilityTextOnlyWarning'
        : 'visionCapabilityUndeclaredWarning'
    }

'''
text = replace_between(
    text,
    '    function filterVisionBackendGroups(groups, capabilities) {',
    '    // ── field specs',
    filter_block,
    'replace client capability filtering helpers',
)

old_hidden_memo = '''      const hiddenVisionBackends = useMemo(
        () =>
          visionCaps.status === 'ready'
            ? collectFilteredVisionBackends(catalog.groups, visionCaps.capabilities)
            : [],
        [catalog.groups, visionCaps.status, visionCaps.capabilities],
      )
'''
new_hidden_memo = '''      const hiddenVisionBackends = useMemo(
        () => collectFilteredVisionBackends(catalog.groups, visionCaps.capabilities),
        [catalog.groups, visionCaps.capabilities],
      )
'''
text = replace_once(text, old_hidden_memo, new_hidden_memo, 'derive uncertain backends independent of capability status')

text = replace_once(
    text,
    '''            if (visionCaps.status === 'ready' && filled.some((row) => !visionModelVisible(row.provider, row.model))) {
              return undefined
            }
''',
    '',
    'remove capability-based save rejection',
)

old_invalid_rows = '''        const invalidRows =
          visionCaps.status === 'ready'
            ? rows.filter((row) => row && row.provider && row.model && !visionModelVisible(row.provider, row.model))
            : []
'''
new_invalid_rows = '''        const invalidRows = catalogReady
          ? rows.filter((row) => row && row.provider && row.model && !visionModelVisible(row.provider, row.model))
          : []
        const advisoryRows = rows
          .filter((row) => row && row.provider && row.model && visionModelVisible(row.provider, row.model))
          .map((row) => {
            const capability =
              visionCaps.capabilities && visionCaps.capabilities[row.provider]
                ? visionCaps.capabilities[row.provider][row.model]
                : undefined
            const warningKey = visionCapabilityWarningKey(capability, visionCaps.status)
            return warningKey ? { ...row, warningKey } : undefined
          })
          .filter(Boolean)
'''
text = replace_once(text, old_invalid_rows, new_invalid_rows, 'derive advisory selected rows')

invalid_marker = '''          invalidRows.length > 0
            ? h('p', { className: 'vr-invalid' },
                t('chainInvalidCurrent') + ' ' + invalidRows.map((row) => row.provider + '/' + row.model).join('、'))
            : null,
'''
advisory_render = '''          advisoryRows.map((row) =>
            h('p', { className: 'vr-hint vr-stealth-notice', key: `cap-${row.provider}/${row.model}` },
              `${row.provider}/${row.model} — ${t(row.warningKey)}`,
            ),
          ),
'''
text = replace_once(text, invalid_marker, advisory_render + invalid_marker, 'render inline capability warnings')
text = replace_once(text, '              emptyVisionModelsPanel(),\n', '', 'remove obsolete all-hidden panel')
text = replace_once(
    text,
    '    exports.collectFilteredVisionBackends = collectFilteredVisionBackends\n',
    '    exports.collectFilteredVisionBackends = collectFilteredVisionBackends\n    exports.visionCapabilityWarningKey = visionCapabilityWarningKey\n',
    'export capability warning helper',
)

write(path, text)


# ── docs ────────────────────────────────────────────────────────────────────
path = 'README.md'
text = read(path)
text = replace_once(
    text,
    'The built-in anonymous OVH vision fallback is already configured, so normal image use needs no signup or API key. **The lower-right chat picker selects only the brain/conversation model**; vision backends do not belong there. Advanced options live under **Settings → Plugins → Plugin config → 视觉路由（自动识图）**: each vision-backend row selects one image-capable user model already configured under **Settings → Models**. Leaving every user row empty is valid; the OVH chain remains the final fallback. `Vision HTTP` is an internal transport route, not a model group users should select.',
    'The built-in anonymous OVH vision fallback is already configured, so normal image use needs no signup or API key. **The lower-right chat picker selects only the brain/conversation model**; vision backends do not belong there. Advanced options live under **Settings → Plugins → Plugin config → 视觉路由（自动识图）**: each vision-backend row may select any callable generative user model already configured under **Settings → Models**. DSH image-capability metadata is advisory only: undeclared or text-only-labelled models remain selectable and show a warning. At runtime Vision Router always tries the provider\'s registered DSH adapter first — including WebSocket, RPC and private transports — and falls through on a real failure. The direct compatibility bridge is used only when an http(s) OpenAI Chat Completions endpoint is positively identified. Leaving every user row empty is valid; the OVH chain remains the final fallback. `Vision HTTP` is an internal transport route, not a model group users should select.',
    'README advisory backend policy',
)
write(path, text)

path = 'README.zh.md'
text = read(path)
text = replace_once(
    text,
    '默认已经有内置 OVH 匿名视觉兜底，无需注册、无需 Key。**聊天页右下角只选择“脑子/会话模型”**；视觉模型不要在那里选。高级配置在 **设置 → 插件 → 插件配置 → 视觉路由（自动识图）**：视觉后端链每一行只选择一个你在 **设置 → 模型** 中已经配置且支持图片输入的用户模型；一行都不填也可以，OVH 免费链会固定在最后兜底。插件内部的 `Vision HTTP` 只是传输实现，不是用户需要选择的模型组。',
    '默认已经有内置 OVH 匿名视觉兜底，无需注册、无需 Key。**聊天页右下角只选择“脑子/会话模型”**；视觉模型不要在那里选。高级配置在 **设置 → 插件 → 插件配置 → 视觉路由（自动识图）**：视觉后端链每一行都可以选择 **设置 → 模型** 中任意可调用的生成式用户模型。DSH 的图片能力声明现在只作提示：未声明图片能力、甚至被标成仅文本的模型也会列出并给出警告。运行时永远先通过该供应商已注册的 DSH adapter 实际调用，因此 WebSocket、RPC 和私有协议都保留原生传输；只有明确识别为 http(s) OpenAI Chat Completions 的渠道才可能进入 HTTP 直连兼容兜底。实际调用失败后自动尝试下一后端；一行都不填也可以，OVH 免费链会固定在最后兜底。插件内部的 `Vision HTTP` 只是传输实现，不是用户需要选择的模型组。',
    'README.zh advisory backend policy',
)
write(path, text)


# ── regression tests ────────────────────────────────────────────────────────
new_test = ROOT / 'tests' / 'capability-advisory.test.js'
new_test.write_text('''import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport {\n  decideVisionBackendCapability,\n  isOpenAIHttpBridgeTransport,\n} from '../index.js'\n\ntest('undeclared and text-only metadata are advisory for generative backends', () => {\n  const unknown = decideVisionBackendCapability(undefined, 'custom-ws', 'mystery-chat', [])\n  assert.equal(unknown.image, false)\n  assert.equal(unknown.attemptable, true)\n  assert.match(unknown.reason, /does not declare image input/)\n\n  const textOnly = decideVisionBackendCapability(\n    { inputModalities: ['text'] },\n    'custom-provider',\n    'mystery-chat',\n    [],\n  )\n  assert.equal(textOnly.image, false)\n  assert.equal(textOnly.attemptable, true)\n  assert.match(textOnly.reason, /declares no image input/)\n})\n\ntest('non-generative endpoints remain a hard structural exclusion', () => {\n  const embedding = decideVisionBackendCapability(\n    { inputModalities: ['text', 'image'] },\n    'custom',\n    'qwen-vl-embedding',\n    [],\n  )\n  assert.equal(embedding.image, false)\n  assert.equal(embedding.attemptable, false)\n})\n\ntest('direct compatibility bridge accepts only http(s) OpenAI Chat Completions', () => {\n  assert.equal(\n    isOpenAIHttpBridgeTransport({ api: 'openai-completions', baseURL: 'https://example.test/v1' }),\n    true,\n  )\n  assert.equal(\n    isOpenAIHttpBridgeTransport({ api: 'openai-completions', baseURL: 'http://127.0.0.1:9000/v1' }),\n    true,\n  )\n  assert.equal(\n    isOpenAIHttpBridgeTransport({ api: 'openai-completions', baseURL: 'wss://example.test/v1' }),\n    false,\n  )\n  assert.equal(\n    isOpenAIHttpBridgeTransport({ api: 'anthropic-messages', baseURL: 'https://example.test/v1' }),\n    false,\n  )\n})\n''', encoding='utf-8')

path = 'tests/client.test.js'
text = read(path)
if 'vision backend picker keeps generative models when image metadata is advisory' in text:
    raise RuntimeError('client advisory regression test already exists')
text += '''\n\ntest('vision backend picker keeps generative models when image metadata is advisory', () => {\n  const bundle = loadClientBundle()\n  const groups = [\n    { id: 'custom-ws', name: 'WS provider', models: [\n      { id: 'mystery-chat', name: 'Mystery chat' },\n      { id: 'embed-model', name: 'Embedding' },\n    ] },\n    { id: 'declared', name: 'Declared', models: [{ id: 'vision', name: 'Vision' }] },\n  ]\n  const capabilities = {\n    'custom-ws': {\n      'mystery-chat': { image: false, attemptable: true, inputModalities: ['text'] },\n      'embed-model': { image: false, attemptable: false, inputModalities: ['text', 'image'] },\n    },\n    declared: {\n      vision: { image: true, attemptable: true, inputModalities: ['text', 'image'] },\n    },\n  }\n  const filtered = bundle.filterVisionBackendGroups(groups, capabilities)\n  assert.deepEqual(filtered.map((group) => [group.id, group.models.map((model) => model.id)]), [\n    ['custom-ws', ['mystery-chat']],\n    ['declared', ['vision']],\n  ])\n  assert.equal(\n    bundle.visionCapabilityWarningKey(capabilities['custom-ws']['mystery-chat'], 'ready'),\n    'visionCapabilityTextOnlyWarning',\n  )\n  assert.equal(bundle.visionCapabilityWarningKey(undefined, 'error'), 'visionCapabilityUnknownWarning')\n  assert.equal(bundle.visionCapabilityWarningKey(capabilities.declared.vision, 'ready'), undefined)\n})\n'''
write(path, text)

print('advisory vision capability migration applied')
