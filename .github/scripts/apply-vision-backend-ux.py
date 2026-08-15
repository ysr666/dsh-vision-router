from pathlib import Path
import re


def read(path): return Path(path).read_text()
def write(path, text): Path(path).write_text(text)
def rep(path, old, new, count=1):
    text = read(path)
    if text.count(old) < count:
        raise SystemExit(f'missing expected text in {path}: {old[:100]!r}')
    write(path, text.replace(old, new, count))
def sub(path, pattern, repl, count=1):
    text = read(path)
    out, n = re.subn(pattern, repl, text, count=count, flags=re.S)
    if n != count:
        raise SystemExit(f'pattern matched {n}, expected {count}, in {path}: {pattern[:100]!r}')
    write(path, out)

# User-configured HTTP endpoints stay first; built-in OVH is appended only as fallback.
sub('index.js', r"export function httpProvidersOf\(config, allowDefault = true\) \{.*?\n\}\n\n/\*\*\n \* Drop http providers", """export function httpProvidersOf(config, allowDefault = true) {
  const configured = Array.isArray(config.httpProviders)
    ? config.httpProviders.filter(
        (p) => p && typeof p.baseURL === 'string' && typeof p.model === 'string',
      )
    : []
  if (!allowDefault) return configured
  const seen = new Set(configured.map((p) => `${p.name}/${p.model}`))
  return [
    ...configured,
    ...DEFAULT_HTTP_PROVIDERS.filter((p) => !seen.has(`${p.name}/${p.model}`)),
  ]
}

/**
 * Drop http providers""")

# Remove the old special-case that promoted vision-http/default OVH to the front.
sub('index.js', r"  const httpProviders = \(\) => \{\n    const raw = httpProvidersOf\(current\(\), current\(\)\.freeFallback !== false\).*?\n  \}\n  const resolveCredential", """  const httpProviders = () => {
    const raw = httpProvidersOf(current(), current().freeFallback !== false)
    return dedupeHttpProviders(
      pairs().filter((pair) => pair && pair.provider !== 'vision-http'),
      raw,
    )
  }
  const resolveCredential""")

# Internal transport route remains callable but publishes no models to the global picker.
sub('index.js', r"(    const httpAdapter = \{.*?      providerRetryPolicy\(\) \{\n        return undefined\n      \},)\n      async listModels\(\) \{\n        return httpEntries\.map\(\(entry\) => \(\{.*?\n        \}\)\)\n      \},", r"\1\n      async listModels() {\n        return []\n      },")

# Surface built-in fallback metadata only to our settings card.
rep('index.js', """              const capabilities = await collectVisionBackendCapabilities()
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ capabilities }))""", """              const capabilities = await collectVisionBackendCapabilities()
              const builtinFallback = DEFAULT_HTTP_PROVIDERS.map((provider) => ({
                id: `${provider.name}/${provider.model}`,
                model: provider.model,
              }))
              res.writeHead(200, { 'content-type': 'application/json' })
              res.end(JSON.stringify({ capabilities, builtinFallback, anonymousRpmPerModel: 2 }))""")

# Onboarding.
rep('lib/client.js', "onboardingTitle: 'Vision Router 已准备好 👁️',", "onboardingTitle: 'Vision Router 已准备好 🎉',")
rep('lib/client.js', "onboardingTitle: 'Vision Router is ready 👁️',", "onboardingTitle: 'Vision Router is ready 🎉',")
rep('lib/client.js', "onboardingBody: '你已有的模型已经自动获得识图入口。要发送图片，请点击聊天页右下角的模型选择器，选择带「+ 自动识图」的模型组。',", "onboardingBody: '你已有的模型已经自动获得识图入口。聊天页右下角只选择会话/文字模型：发图片时选带「+ 自动识图」的模型组；视觉后端在插件设置里单独配置。',")
rep('lib/client.js', "onboardingBody: 'Your existing models now have image-ready entries. To send an image, open the model selector in the lower-right corner of chat and choose a model group marked “+ Auto Vision”.',", "onboardingBody: 'Your existing models now have image-ready entries. The lower-right picker is only for the conversation/text model: choose a group marked “+ Auto Vision” when sending images; vision backends are configured separately in plugin settings.',")

# Settings copy: rows are user models; OVH is automatic fixed fallback.
rep('lib/client.js', "chainHint: '这里只会显示模型元数据中明确声明支持图片输入的模型；纯文本 DeepSeek / opencode 会自动从下拉列表隐藏。第一行是主视觉模型，后面的行在失败时依次回退。',", "chainHint: '上面每一行只选择一个你在「设置 → 模型」中已经配置、且明确支持 image 输入的用户模型；从上到下依次尝试。可以一行都不填，下方内置 OVH 免费兜底仍会工作。',")
rep('lib/client.js', "chainHint: 'This dropdown only shows models whose metadata explicitly declares image input. Text-only DeepSeek/opencode models are filtered out automatically. The first row is primary; later rows are tried in order on failure.',", "chainHint: 'Each row selects one user model already configured under Settings → Models and explicitly declaring image input. Rows are tried top to bottom. You may leave them all empty; the built-in OVH fallback below still works.',")
rep('lib/client.js', "        '下面是识图工具真正调用的“眼睛”后端，不是聊天页右下角要选择的会话模型组。第一行默认是内置免费视觉模型（免注册、免 Key，每 IP 2 次/分钟）；通常保留默认即可。',", "        '这里配置识图工具真正调用的“眼睛”，不是聊天页右下角的“脑子/会话模型”。上面的行只选你自己的视觉模型；内置 OVH 匿名免费链固定显示在最下方，不需要选择 Vision HTTP。',")
rep('lib/client.js', "        'The section below configures the actual “eyes” backend called by the vision tools; it is not the conversation model group you pick in the lower-right selector. The first row is the built-in free vision model (no signup, no key, 2 req/min per IP); the default is usually enough.',", "        'This section configures the “eyes” used by the vision tools, not the brain/conversation model in the lower-right picker. The rows above are only your own vision models; the built-in anonymous OVH chain is fixed at the bottom and never requires selecting Vision HTTP.',")
rep('lib/client.js', "visionCapsError: '视觉能力元数据暂时不可用；为防止误选，当前只显示内置 Vision HTTP 模型。',", "visionCapsError: '视觉能力元数据暂时不可用；为防止误选，暂不提供用户视觉模型下拉。内置 OVH 免费兜底仍可用。',")
rep('lib/client.js', "visionCapsError: 'Vision capability metadata is unavailable; to prevent bad selections, only the built-in Vision HTTP models are shown for now.',", "visionCapsError: 'Vision capability metadata is unavailable; user vision-model choices are hidden to prevent bad selections. The built-in OVH fallback still works.',")
rep('lib/client.js', "hintFreeFallback: '未显式配置 httpProviders 时启用内置免 Key 免费端点兜底；默认开启。',", "hintFreeFallback: '启用内置 OVH 匿名视觉链作为最终兜底：免注册、免 Key，并在你选择的用户视觉模型之后尝试；默认开启。',")
rep('lib/client.js', "hintFreeFallback: 'Enables the built-in keyless free endpoint fallback when httpProviders are not explicitly configured; on by default.',", "hintFreeFallback: 'Keeps the built-in anonymous OVH vision chain as the final fallback after your user-selected vision models; no signup or API key required. On by default.',")

# Fallback card strings.
rep('lib/client.js', "      builtinFreeTag: '（内置免费模型）',", "      builtinFreeTag: '（内置免费模型）',\n      builtinFallbackLabel: '内置免费兜底（自动）',\n      builtinFallbackEnabled: '已启用',\n      builtinFallbackDisabled: '已关闭',\n      builtinFallbackBody: 'OVHcloud 匿名视觉链共 {count} 个模型，首选 {primary}。匿名限额为每 IP、每模型 2 次/分钟；5 个模型独立限额，理论合计约 10 次/分钟，实际以 OVH 限流为准。它固定在上面用户模型之后尝试，免注册、免 Key。',")
rep('lib/client.js', "      builtinFreeTag: ' (built-in free model)',", "      builtinFreeTag: ' (built-in free model)',\n      builtinFallbackLabel: 'Built-in free fallback (automatic)',\n      builtinFallbackEnabled: 'Enabled',\n      builtinFallbackDisabled: 'Disabled',\n      builtinFallbackBody: 'The anonymous OVHcloud vision chain contains {count} models, starting with {primary}. Anonymous limits are 2 requests/minute per IP per model; five independent model buckets are about 10 RPM in theory, subject to OVH rate limiting. It always runs after your user models and needs no signup or API key.',")

# Never show internal vision-http in any user-facing model/provider dropdown.
rep('lib/client.js', "            if (group.id === 'vision-http') return true", "            if (group.id === 'vision-http') return false")
rep('lib/client.js', "      const [visionCaps, setVisionCaps] = useState({ status: 'idle', capabilities: {}, error: undefined })", "      const [visionCaps, setVisionCaps] = useState({ status: 'idle', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2, error: undefined })")
rep('lib/client.js', "        setVisionCaps({ status: 'loading', capabilities: {}, error: undefined })", "        setVisionCaps({ status: 'loading', capabilities: {}, builtinFallback: [], anonymousRpmPerModel: 2, error: undefined })")
rep('lib/client.js', """                capabilities: body && body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {},
                error: undefined,""", """                capabilities: body && body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {},
                builtinFallback: body && Array.isArray(body.builtinFallback) ? body.builtinFallback : [],
                anonymousRpmPerModel: body && Number.isFinite(body.anonymousRpmPerModel) ? body.anonymousRpmPerModel : 2,
                error: undefined,""")
rep('lib/client.js', """                status: 'error',
                capabilities: {},
                error: error && error.message ? error.message : String(error),""", """                status: 'error',
                capabilities: {},
                builtinFallback: [],
                anonymousRpmPerModel: 2,
                error: error && error.message ? error.message : String(error),""")
rep('lib/client.js', "          if (catalogReady) return Array.isArray(value) ? value : []", "          if (catalogReady) return Array.isArray(value) ? value.filter((row) => row && row.provider !== 'vision-http') : []")
rep('lib/client.js', "      const groupOptions = catalog.groups.map((group) =>", "      const groupOptions = catalog.groups.filter((group) => group.id !== 'vision-http').map((group) =>")

suffix = " +\n          (group.id === 'vision-http' ? t('builtinFreeTag') : '')"
text = read('lib/client.js')
if text.count(suffix) != 2: raise SystemExit(f'expected 2 vision-http group label suffixes, got {text.count(suffix)}')
write('lib/client.js', text.replace(suffix, ''))
text = read('lib/client.js')
text, n = re.subn(r" \+\n\s*\((?:row|pair)\.provider === 'vision-http' \? t\('freeTag'\) : ''\)", '', text)
if n != 3: raise SystemExit(f'expected 3 blanket free model labels, got {n}')
write('lib/client.js', text)

# Fixed OVH card appears under user rows.
rep('lib/client.js', "      const textProviderEditor = () => {", """      const builtinFallbackPanel = () => {
        const list = Array.isArray(visionCaps.builtinFallback) ? visionCaps.builtinFallback : []
        const enabled = format('freeFallback') !== false
        const primary = list[0] && list[0].model ? list[0].model : 'Qwen3.5-397B-A17B'
        const count = list.length > 0 ? list.length : 5
        return h('div', { className: 'vr-field' },
          h('div', { className: 'vr-field-head' },
            h('span', { className: 'vr-label' }, t('builtinFallbackLabel')),
            h('span', { className: 'vr-badge' }, enabled ? t('builtinFallbackEnabled') : t('builtinFallbackDisabled')),
          ),
          h('p', { className: 'vr-hint' }, t('builtinFallbackBody', { count, primary })),
        )
      }
      const textProviderEditor = () => {""")
rep('lib/client.js', """              catalogReady
                ? chainEditor()
                : textField('providers', t('textProviders'), t('textProvidersHint'), true),""", """              catalogReady
                ? chainEditor()
                : textField('providers', t('textProviders'), t('textProvidersHint'), true),
              builtinFallbackPanel(),""")

# Tests.
rep('tests/client.test.js', "test('filterVisionBackendGroups hides text-only models and keeps built-in vision-http', () => {", "test('filterVisionBackendGroups hides text-only models and the internal vision-http route', () => {")
rep('tests/client.test.js', """  assert.deepEqual(filtered.map((group) => [group.id, group.models.map((model) => model.id)]), [
    ['vision-http', ['free']],
    ['opencode-go', ['qwen-vl']],
  ])
  assert.deepEqual(bundle.filterVisionBackendGroups(groups, {}).map((group) => group.id), ['vision-http'])""", """  assert.deepEqual(filtered.map((group) => [group.id, group.models.map((model) => model.id)]), [
    ['opencode-go', ['qwen-vl']],
  ])
  assert.deepEqual(bundle.filterVisionBackendGroups(groups, {}).map((group) => group.id), [])""")
core = read('tests/core.test.js')
if 'httpProvidersOf appends built-in OVH fallback after configured HTTP providers' not in core:
    core += """

test('httpProvidersOf appends built-in OVH fallback after configured HTTP providers', () => {
  const custom = { name: 'custom', baseURL: 'https://example.test/v1', model: 'vision-x', apiKeyEnv: '' }
  const withFallback = httpProvidersOf({ httpProviders: [custom] }, true)
  assert.equal(withFallback[0], custom)
  assert.equal(withFallback.length, 1 + DEFAULT_HTTP_PROVIDERS.length)
  assert.equal(withFallback[1].model, DEFAULT_HTTP_PROVIDERS[0].model)
  assert.deepEqual(httpProvidersOf({ httpProviders: [custom] }, false), [custom])
})
"""
    write('tests/core.test.js', core)

# README: brain vs eyes and fixed OVH fallback.
rep('README.zh.md', '默认已经有内置免费视觉后端，无需额外配置 Key。高级配置在 **设置 → 插件 → 插件配置 → 视觉路由（自动识图）**；如果只是普通看图，通常不需要改设置。', '默认已经有内置 OVH 匿名视觉兜底，无需注册、无需 Key。**聊天页右下角只选择“脑子/会话模型”**；视觉模型不要在那里选。高级配置在 **设置 → 插件 → 插件配置 → 视觉路由（自动识图）**：视觉后端链每一行只选择一个你在 **设置 → 模型** 中已经配置且支持图片输入的用户模型；一行都不填也可以，OVH 免费链会固定在最后兜底。插件内部的 `Vision HTTP` 只是传输实现，不是用户需要选择的模型组。')
rep('README.md', 'The built-in free vision backend is already configured, so normal image use needs no API key or extra setup. Advanced options live under **Settings → Plugins → Plugin config → 视觉路由（自动识图）**.', 'The built-in anonymous OVH vision fallback is already configured, so normal image use needs no signup or API key. **The lower-right chat picker selects only the brain/conversation model**; vision backends do not belong there. Advanced options live under **Settings → Plugins → Plugin config → 视觉路由（自动识图）**: each vision-backend row selects one image-capable user model already configured under **Settings → Models**. Leaving every user row empty is valid; the OVH chain remains the final fallback. `Vision HTTP` is an internal transport route, not a model group users should select.')
sub('README.zh.md', r"视觉链按顺序逐个尝试，全部失败才报错：\n\n1\. \*\*内置免费端点\*\*.*?\n2\. 配置的 `httpProviders`.*?\n3\. 配置的 `providers`.*?。", """视觉工具按顺序逐个尝试，全部失败才报错：

1. **用户视觉模型**：设置卡里一行一个，从上到下；只显示 **设置 → 模型** 中明确声明支持 image 输入的模型；
2. **高级自定义 HTTP 视觉端点**：如果旧配置/高级配置中存在 `httpProviders`，在用户模型之后尝试；
3. **内置 OVH 匿名免费兜底**：固定最后尝试，不需要出现在任何模型选择器里。当前内置链按质量优先为 `Qwen3.5-397B-A17B` → `Qwen2.5-VL-72B-Instruct` → `Qwen3.6-27B` → `Mistral-Small-3.2-24B-Instruct-2506` → `Qwen3.5-9B`。OVH 匿名限额为 **每 IP、每模型 2 次/分钟**；5 个模型是独立限额，因此理论上分散请求可到约 **10 次/分钟**，实际仍以 OVH 当时的限流为准。免注册、免 Key。""")
sub('README.md', r"The vision chain walks providers in order and only surfaces an error after every one failed:\n\n1\. the \*\*built-in free endpoint\*\*.*?\n2\. configured `httpProviders`.*?;\n3\. configured `providers`.*?\.\n", """The vision tools try backends in order and surface an error only after all of them fail:

1. **User vision models**: one per settings row, top to bottom; only models under **Settings → Models** that explicitly declare image input are shown;
2. **Advanced custom HTTP vision endpoints**: legacy/advanced `httpProviders`, when present, run after the user models;
3. **Built-in anonymous OVH fallback**: always last and never exposed in a model picker. The current quality-first chain is `Qwen3.5-397B-A17B` → `Qwen2.5-VL-72B-Instruct` → `Qwen3.6-27B` → `Mistral-Small-3.2-24B-Instruct-2506` → `Qwen3.5-9B`. OVH anonymous limits are **2 requests/minute per IP per model**. The five models have independent buckets, so spreading requests across them is about **10 RPM in theory**, subject to OVH's actual rate limiting. No signup or API key is required.
""")
rep('README.zh.md', '这里的“视觉链”是 Vision Router 调用的**视觉后端**，必须填写真正支持图片输入的模型；它和聊天页右下角的「+ 自动识图」会话模型组不是一回事。不要把纯文本 DeepSeek / opencode 模型当成视觉后端备用模型。', '这里的“视觉链”是 Vision Router 调用的**眼睛**：设置页里每一行只选一个用户视觉模型；聊天页右下角选择的是**脑子/会话模型**，两者完全分开。纯文本 DeepSeek / opencode 不会出现在视觉后端下拉里；内部 `Vision HTTP` 也不会再暴露给用户。')
rep('README.md', 'This “vision chain” is the **vision backend** called by Vision Router. The settings UI reads exact DSH model metadata and **only shows models that explicitly declare image input**; text-only DeepSeek/opencode models are filtered out. Legacy configs that still contain a text-only vision backend are skipped at runtime as well. This is separate from the “+ Auto Vision” conversation model group in the lower-right selector.', 'This “vision chain” is the **eyes** used by Vision Router: each settings row selects one user vision model, while the lower-right chat picker selects the **brain/conversation model**. The two are deliberately separate. Text-only DeepSeek/opencode models are filtered out of the vision-backend dropdown, and the internal `Vision HTTP` transport route is no longer exposed to users.')
