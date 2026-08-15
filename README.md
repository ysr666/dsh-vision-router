<p align="center">
  <img src="assets/hero.svg" width="100%" alt="DSH Vision Router — eyes for text-only DeepSeek Harness agents" />
</p>

<h1 align="center">dsh-vision-router</h1>

<p align="center"><strong>Paste an image and it just works — eyes for text-only agents on DeepSeek Harness. Free out of the box, no key, no Python, one command.</strong></p>

<p align="center">DeepSeek keeps thinking; the built-in free vision chain and ten pixel-level tools do the seeing. Image turns behave like ordinary tool-calling turns — grounded, measurable, repeatable.</p>

<p align="center">
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome · DSH plugin" /></a>
  <a href="https://github.com/ysr666/dsh-vision-router/releases/tag/v1.1.1"><img src="https://img.shields.io/badge/release-v1.1.1-5B4CF0?style=flat-square" alt="Release v1.1.1" /></a>
  <a href="tests"><img src="https://img.shields.io/badge/verified-102%20tests-2EA44F?style=flat-square" alt="Verified: 102 tests" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat-square" alt="License: MIT" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white" alt="Node.js >=22" /></a>
  <img src="https://img.shields.io/badge/runtime-no%20Python-8A2BE2?style=flat-square" alt="No Python" />
  <a href="cordis.patch.yml"><img src="https://img.shields.io/badge/DSH-Web%20profile-5B4CF0?style=flat-square" alt="DSH Web profile" /></a>
</p>

<p align="center">English · <a href="README.zh.md">中文</a></p>

> [!WARNING]
> 📌 **Announcement (v1.1.1)**
>
> Existing DSH providers are now **auto-wrapped on install**: text-only routes gain a same-name **“+ Auto Vision”** model group, while native multimodal models keep their original image input and use Vision Router tools only when useful. **Before sending an image, choose the “+ Auto Vision” group from the lower-right model selector; the original group is intentionally left untouched.** Model and wrapper changes hot-update without a restart. Windows sharp/libvips startup conflicts are fixed by sharing the host sharp; install/update docs distinguish npm/npx from source-checkout pnpm usage.

<p align="center">
  <img src="assets/vision-demo.gif" width="640" alt="Demo: paste an image, the agent locates the send button with vision_ground / vision_crop / vision_pixel_diff and answers with coordinates" />
</p>

## Why this exists

Most DSH vision plugins bridge images to DeepSeek as *text descriptions* — lossy, one-shot, and blind to pixels. This plugin keeps the **original pixels on the vision model's side** and DeepSeek on the reasoning side, and makes looking at an image an **ordinary tool call**:

- **One command install.** The package ships its own composition patch (`dsh.bundle.patch`): `dsh plugin add` wires the row, the admission wrapper and the attachment limits automatically — zero manual file edits. Taking over the official DeepSeek route is an optional setting (stealth mode, off by default).
- **Free by default.** The vision chain starts with a built-in OVHcloud anonymous endpoint (`Qwen2.5-VL-72B-Instruct`, no account, no key, 2 req/min per IP). Paid chains (OpenRouter, Pi-AI providers, direct OpenAI-compatible endpoints) are optional upgrades.
- **No Python.** The whole pipeline — downscale, grounding, crop, pixel diff, palette, OCR, SVG trace, cutout, HTML screenshot — runs on sharp / potrace / tesseract / system Chrome.
- **Continuous multi-step image work.** An image turn is a text turn that calls tools: `vision_ground` → `vision_crop` → `vision_describe` → `vision_pixel_diff` → fix → screenshot again. The agent keeps iterating until the work is done.
- **DeepSeek stays the brain.** Text turns are untouched in model, cost and context. The vision model is only the eyes, called on demand; answers are cached by image content.
- **Transparent to the user.** Uploaded images keep rendering as images in the conversation UI; the rewrite that points the model at the vision tools happens only inside the model call, never in the session log.

## How it compares

The closest alternative is [@anionex/dsh-vision-toolkit](https://github.com/Anionex/dsh-vision-toolkit) (Anionex), a native DSH bundle of the well-known `agent-vision-toolkit` lineage. Both packages ship a `vision-tools` skill and a family of pixel-level tools; they differ in philosophy — **zero-config paste-and-go** versus **agent-driven visual engineering**:

| | dsh-vision-router | @anionex/dsh-vision-toolkit |
|---|---|---|
| Image Q&A out of the box | ✅ Built-in free chain (anonymous OVHcloud endpoint) — no account, no key | Requires your own vision API key (local pixel tools work without one) |
| Runtime | ✅ Node only — no Python | Python 3.11+ managed runtime |
| Getting an image in | ✅ Pick a “+ Auto Vision” group once, then paste directly | Workspace path + `/vision-tools` command, then explicit tool calls |
| Turn routing | ✅ Image turns switch to vision, text turns switch back to DeepSeek — optional stealth takeover keeps the model picker looking stock | Tool-driven; no whole-turn auto-routing |
| Profiles | Web | Web + Headless |
| Playbooks | The pixel loop: ground → crop → diff → fix → screenshot again | Richer case library (long-screenshot OCR, UI restoration, GUI automation) |
| Tests | 86 | 162 |
| Install | One command | One command (npm) |

Both are MIT-licensed and one command away. Pick this plugin when you want images to *just work* with zero setup; pick theirs when you need headless profiles or the extended playbook library. (Feature comparison reflects their README as of 2026-08.)

## Quick start

### 1. Install and load the plugin

Recommended for normal npm/npx installs (the same launch style used by the DSH README):

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router
npx @deepseek-ai/dsh web
```

If you run DeepSeek Harness from a source checkout with pnpm, use the workspace script instead — `dsh` is not necessarily on your shell `PATH`:

```sh
cd deepseek-harness
pnpm dsh plugin --profile web add dsh-vision-router
pnpm dsh web
```

If you already installed the DSH CLI globally and `dsh` is on `PATH`, the shorter `dsh ...` form works too.

> [!NOTE]
> If you install the plugin **into a Web process that was already running long-term**, let that DSH Web process reload once so the plugin bundle itself is discovered. After the plugin is loaded, adding/removing models or changing wrapper scope **hot-updates without further DSH restarts**.

### 2. Switch to a “+ Auto Vision” model group in chat

Once loaded, the plugin discovers the model groups enabled under **Settings → Models** and creates same-name auto-vision entries. For example:

```text
opencode-go                 ← original model group, unchanged
opencode-go + Auto Vision   ← choose this when sending images
```

> [!IMPORTANT]
> **Before sending an image, open the model selector in the lower-right corner of the chat composer and choose a group marked “+ Auto Vision”.**
>
> Vision Router deliberately **does not modify the original model group**. If the conversation still uses the original text-only opencode / DeepSeek route, DSH can reject the image with “the current model does not support images” *before Vision Router gets a chance to handle it*. That is a model-entry selection issue, not a broken vision backend.

The auto-vision group follows the live DSH model catalog. Adding models or changing wrapper scope does not require a restart.

### 3. Paste or upload the image

After choosing the “+ Auto Vision” group, paste or upload an image normally. The agent auto-mounts the vision tools and can use `vision_describe`, `vision_ground`, `vision_crop`, and the rest across multiple steps when needed.

The built-in free vision backend is already configured, so normal image use needs no API key or extra setup. Advanced options live under **Settings → Plugins → Plugin config → 视觉路由（自动识图）**.

### See it in action

*Left: an image turn — the user sends a picture, the agent calls `vision_describe` through the free chain and answers. Right: the finished structured answer.*

<p align="center">
  <img src="assets/dsh-conversation-image-qa.png" width="49%" alt="A conversation turn in which the agent looks at an uploaded image through vision_describe." />
  <img src="assets/dsh-conversation-image-qa-result.png" width="49%" alt="The agent's structured answer describing the image content." />
</p>

## Highlights

- **Original pixels, real answers.** The vision chain reads the image at original resolution (auto-downscaled only to protect latency/quota); the agent's question travels with the image, so answers are about *your* question, not a generic description.
- **Automatic failover with classified errors.** Region blocks, ToS filtering, 402 quota, 429 rate limits (with Retry-After backoff), context overflow, network failures — the chain walks providers one by one and only reports after all of them failed, with actionable advice.
- **Image memory.** Vision answers are cached by attachment content hash; later text turns substitute the recorded description (marked as untrusted evidence), so DeepSeek genuinely remembers earlier images without re-spending vision calls.
- **A verifiable pixel loop.** Reference → `vision_html_screenshot` → `vision_pixel_diff` (ratio + red heatmap + worst-region ranking) → fix → repeat until the mismatch converges. UI restoration becomes measurable instead of eyeballed.
- **Progressive schema exposure.** Only a zero-arg `vision_activate` bootstrap is always visible; image turns auto-mount all ten deep tools with a one-time usage note, and a `vision-tools` skill is registered for text-only turns.
- **Selective proxy.** Only the configured vision provider hosts go through your local proxy; DeepSeek stays direct.

### Pixel loop in practice

<p align="center">
  <img src="assets/pixel-loop.png" width="100%" alt="Reference design and final agent rebuild, verified with vision_pixel_diff at 2.54% final difference." />
</p>

The agent rebuilt the UI from the reference image, then verified the final result with `vision_pixel_diff`: **2.54% final diff** (32,939 / 1,296,000 differing pixels, threshold 16/channel).

## How it works

<p align="center">
  <img src="assets/how-it-works.svg" width="100%" alt="How DSH Vision Router keeps DeepSeek as the brain and vision tools as the eyes." />
</p>

The vision model is **only the eyes**; DeepSeek is **always the brain**. An image turn is never hijacked by a one-shot vision answer — the agent drives the tools itself and can keep operating on the image across as many steps as the task needs.

## Tools

All ten deep tools mount automatically on image turns (`autoActivateOnImage`); text turns can mount them via `vision_activate` or the `/vision-tools` skill. Built on sharp / potrace / tesseract / system Chrome — no Python:

<p align="center">
  <img src="assets/vision-tools.svg" width="100%" alt="Nine vision tools available in DSH Vision Router." />
</p>

| Tool | What it does | Artifact |
|---|---|---|
| `vision_describe` | Image Q&A / multi-image compare / structured-evidence JSON mode (summary + layout regions + entity inventory + verbatim transcription) | — |
| `vision_ground` | Locate a target → **original-pixel box x1/y1/x2/y2** | annotated PNG (optional) |
| `vision_detect` | Numbered inventory of every element of a kind (buttons/inputs/links…) with original-pixel boxes | annotated PNG with numbered boxes |
| `vision_crop` | Crop and zoom into a pixel box | PNG |
| `vision_pixel_diff` | Per-pixel comparison: diff ratio + worst 8×8-grid regions | red heatmap PNG + JSON report |
| `vision_colors` | Dominant colors (hex + share) | — |
| `vision_ocr` | Text transcription: local tesseract (chi_sim+eng) first, vision model fallback | — |
| `vision_trace` | SVG vectorization (potrace posterization; icons/logos) | SVG |
| `vision_extract_foreground` | Cutout via border flood fill (uniform backgrounds) | transparent PNG |
| `vision_html_screenshot` | Screenshot a local HTML file (headless system Chrome) | PNG |
| `vision_long_screenshot_ocr` | Long-screenshot transcription: overlapping chunks, tesseract first / vision model fallback, stitched Markdown | chunk PNGs + Markdown + manifest |

Formats are sniffed from magic bytes, so extensionless content-addressed attachment files work everywhere (no `.png` renaming needed).

**Common workflows**

```text
vision_ground image="ref.png" target="the send button"
vision_detect image="page.png" target="input fields"
vision_crop   image="ref.png" region="1067,841,1108,881"
vision_describe paths=["ref.png","impl.png"] question="list the differences" json=true
vision_pixel_diff original="ref.png" rebuilt="screenshot.png"
vision_ocr image="screenshot.png"
vision_colors image="ref.png" top=8
vision_trace image="icon.png" steps=4
vision_extract_foreground image="logo.png"
vision_html_screenshot source="page.html" width=1200 height=720
vision_long_screenshot_ocr image="chat-log.png" chunkHeight=1200 overlap=120
```

## Provider fallback chain

The vision chain walks providers in order and only surfaces an error after every one failed:

1. the **built-in free endpoint** (`vision-http` → `ovh/Qwen2.5-VL-72B-Instruct`) — no key, best-effort, 2 req/min per IP;
2. configured `httpProviders` (direct OpenAI-compatible endpoints with optional `apiKeyEnv`);
3. configured `providers` / `provider` + `fallbacks` (any adapter-backed provider, e.g. a Pi-AI profile like OpenRouter or Zhipu).

> [!IMPORTANT]
> This “vision chain” is the **vision backend** called by Vision Router. The settings UI reads exact DSH model metadata and **only shows models that explicitly declare image input**; text-only DeepSeek/opencode models are filtered out. Legacy configs that still contain a text-only vision backend are skipped at runtime as well. This is separate from the “+ Auto Vision” conversation model group in the lower-right selector.

> In the legacy `routing: true` mode, the whole-turn chain walks only `provider + fallbacks` — `httpProviders` (including the free fallback) do not participate there. The default `routing: false` (tools-first) tries everything.

Failures are classified (region / tos / quota / rate-limit / context / network) and the final error carries advice; `429` responses honor `Retry-After` once with a capped backoff. Oversized uploads are downscaled before the call (default budget 4 MP) to keep tool calls fast.

## Stealth mode

Stealth mode is **off by default** (explicit opt-in since issue #34): with it off, the official `deepseek-official` route stays untouched and image turns go through the visible "DeepSeek + 自动识图" wrapper entry in the picker.

With stealth on, the plugin takes over the official `deepseek-official` route: the model picker looks exactly like stock (same DeepSeek group, same model names), but each entry is the auto-vision wrapper that declares image input and delegates text turns to a rebuilt native DeepSeek adapter (same `llm-deepseek` settings section and credentials). Old sessions keep working through the hidden `deepseek-vision` alias. The takeover requires the stock row to be absent — disable it in your profile patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  disabled: true
```

With the stock row present, the plugin falls back to the visible wrapper entry. Conversely, with stealth off but the stock row still disabled, the plugin performs a keep-alive takeover so the DeepSeek models don't vanish (the settings card explains this); to restore the fully official route, flip the `disabled` above back to `false` and restart.

> Stealth mode **only affects the official DeepSeek route**. Custom/third-party routes such as opencode are auto-wrapped into “+ Auto Vision” groups by default.

## Auto-vision model groups and manual wrappers

`autoWrapProviders` is on by default. The plugin discovers the provider/model entries currently enabled under **Settings → Models** and registers a same-name “+ Auto Vision” model group for them. **The original group is never changed**: choose the auto-vision group for images, or keep using the original group for plain text. DSH `llm/adapters-updated` events are synced live, so adding/removing models does not require a restart.

`wrappedProviders` is an **optional manual scope control**, not a required setup step. Use it only when:

1. automatic wrapping is off and you want to pick which provider/models receive an auto-vision entry; or
2. automatic wrapping remains on but one provider should expose only selected models in its “+ Auto Vision” group.

The settings card uses provider + model dropdowns; an empty model means every model on that route. Add multiple rows to select multiple models. Changes apply immediately with no restart.

## Web settings

The Web profile registers a **视觉路由（自动识图）** card under **Settings → Plugins → Plugin config**. Its top callout spells out the only step most users need: **return to chat → lower-right model selector → choose a “+ Auto Vision” model group → send the image**. The remaining controls are advanced customization:

- **Auto-create “+ Auto Vision” model groups**: enabled by default; follows the live model catalog with no restart;
- **Manual auto-vision scope (optional)**: only for disabling auto-wrap or limiting selected models;
- **Vision backend chain**: the real image-capable models used by `vision_describe` and friends; the built-in free Qwen is normally enough, and text-only models should not be placed here;
- switches for legacy whole-turn routing, vision tools, image-block rewriting and stealth mode (official DeepSeek route only);
- timeout, wrapper/chain route names, proxy and other advanced parameters;
- every field shows an overridden badge with one-click reset plus discard/save;
- a **Test connection** button probes the first vision provider and reports latency inline;
- artifact-producing tools render dedicated call cards with result facts and open-file buttons.

<p align="center">
  <img src="assets/vision-settings.png" width="72%" alt="The vision-router card in Settings > Plugins > Plugin config." />
</p>

> PR [#8](https://github.com/ysr666/dsh-vision-router/pull/8) upgrades the panel with catalog-driven model dropdowns, add/remove fallback rows, and proxy settings.

## Configuration

Everything is optional; defaults work out of the box. Edit via the Web card or a profile patch:

| Field | Default | Meaning |
|---|---|---|
| `provider` / `model` | `vision-http` / `ovh/Qwen2.5-VL-72B-Instruct` | shorthand **vision backend** route (adapter-backed provider + model that genuinely accepts images) |
| `fallbacks` | `[]` | backup image models for the shorthand vision provider |
| `providers` | built-in free `vision-http` pair | multi-provider **vision backend** chain `{ provider, model, fallbacks[] }`, tried in order; do not put text-only models here |
| `httpProviders` | built-in OVH entry | direct OpenAI-compatible endpoints `{ name, baseURL, model, apiKeyEnv, maxTokens }` |
| `autoWrapProviders` | `true` | discover enabled provider/models and live-sync same-name “+ Auto Vision” groups; original groups stay unchanged |
| `wrappedProviders` | `[{ provider: 'deepseek-official', models: [] }]` | optional manual wrapper scope `{ provider, models[] }`, used after disabling auto-wrap or to restrict one provider to selected models; changes apply live, no restart |
| `routing` | `false` | legacy whole-turn chain routing (one-shot answer). `false` = tools-first flow (recommended) |
| `reverseRouting` | `true` | with `routing: true`, route text turns back to `textProvider` |
| `wrapperRoute` / `chainRoute` | `deepseek-vision` / `vision-chain` | admission wrapper route name / fallback chain route name (empty disables) |
| `stealth` | `false` | take over the official `deepseek-official` route (official row only; custom routes are auto-wrapped by default) |
| `textProvider` | `deepseek-official` / `deepseek-v4-pro` | the model that reasons (your daily model) |
| `tool` / `progressiveTools` / `autoActivateOnImage` | `true` ×3 | vision tools on / progressive mounting / auto-mount on image turns |
| `rewriteImages` | `true` | rewrite image blocks in the model input (cached description or tool-hint marker); the UI log keeps images |
| `downscale` / `downscaleMaxPixels` | `true` / `4000000` | pre-call downscale and its pixel budget (latency guard) |
| `cache` / `cacheTtlSeconds` / `cacheMaxEntries` | `true` / `3600` / `200` | vision answer cache |
| `timeoutMs` | `120000` | per vision call deadline |
| `artifactsDir` | `.dsh-vision-router/artifacts` | artifact directory (relative to the session workspace) |
| `proxy` / `proxyHosts` | `''` / openrouter hosts | optional proxy for vision provider hosts only |

## Requirements

- DeepSeek Harness Web profile. Normal installs can use `npx @deepseek-ai/dsh ...`; source checkouts use `pnpm dsh ...`. A bare `dsh ...` command only works when the CLI is already on your shell `PATH`.
- Node ≥ 22 (host side).
- No API key for the default free chain; a credential reference (`apiKeyEnv`) only for paid `httpProviders`.
- Chrome / Chromium / Edge only for `vision_html_screenshot`; every other tool works without a browser.
- Tesseract is optional: `vision_ocr` falls back to the vision model when the local engine is absent.

## Install and lifecycle

### Install

Normal npm/npx install:

```sh
npx @deepseek-ai/dsh plugin --profile web add dsh-vision-router
npx @deepseek-ai/dsh --profile web --dump-config | grep vision-router
```

From a DeepSeek Harness source checkout:

```sh
pnpm dsh plugin --profile web add dsh-vision-router
pnpm dsh --profile web --dump-config | grep vision-router
```

When first adding the plugin to an already long-lived Web profile, let that Web process reload the plugin bundle; the host discovers the browser bundle through `dsh.client` at startup. **After the plugin is loaded, model-catalog and wrapper-scope changes hot-update and do not require a restart.**

### Disable / re-enable

```yaml
- id: vision-router
  disabled: true
```

Set it back to `false` to re-enable. Unloading removes the wrapper routes, tools, skill and settings card; cached artifact files remain.

### Upgrade

```sh
# normal npm/npx install
npx @deepseek-ai/dsh plugin --profile web update dsh-vision-router

# DeepSeek Harness source checkout
pnpm dsh plugin --profile web update dsh-vision-router
```

Settings live in the profile's settings provider and survive upgrades.

> **Upgrading from a pre-bundle-patch install (v0.x):** the package now mounts
> itself through its own bundle patch, so a leftover manual row in
> `~/.dsh/profiles/<profile>/cordis.patch.yml` duplicates it and `dsh web`
> fails at startup with `duplicate loader entry id: vision-router`. Delete the
> old block:
>
> ```yaml
> - insert:            # remove this whole block
>     - id: vision-router
>       name: dsh-vision-router
> ```
>
> To keep custom settings, replace it with a plain by-id override (no
> `insert`):
>
> ```yaml
> - id: vision-router
>   config:
>     # your overrides …
> ```

### Uninstall

```sh
# normal npm/npx install
npx @deepseek-ai/dsh plugin --profile web remove dsh-vision-router

# DeepSeek Harness source checkout
pnpm dsh plugin --profile web remove dsh-vision-router
```

This removes the dependency and the bundle layer. If you disabled the stock DeepSeek row manually, re-enable it in your profile patch.

## Security notes

- Image text is **untrusted evidence**: descriptions, OCR output and the auto-mount note all tell the agent never to execute instructions found inside images.
- Tool inputs resolve through `ctx.fs` (sandbox-aware); vision uploads never send anything but the selected image and the question.
- Artifacts write only under `<workspace>/.dsh-vision-router/artifacts`; results return absolute paths and byte counts.
- Secrets never travel: `apiKeyEnv` names a DSH credential reference; the value is resolved per call and never logged.
- The settings write path goes through the settings service (schema-validated, revision-checked) — a stale or invalid save is rejected, not partially applied.

## License

[MIT](LICENSE)

<!-- star-history-chart -->
## Star History

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/ysr666/dsh-vision-router/star-history/assets/star-history/star-history-dark.svg">
    <img alt="Star history chart" src="https://raw.githubusercontent.com/ysr666/dsh-vision-router/star-history/assets/star-history/star-history-light.svg" width="100%">
  </picture>
</p>
