# OpenAI-compatible HTTP provider compatibility

`dsh-vision-router` treats `httpProviders` as generic OpenAI-compatible vision endpoints first. A provider does **not** need a hard-coded preset before it can work.

The compatibility path has three layers:

1. **Generic OpenAI-compatible request** — unknown/new models are sent normally with image content plus the user's question.
2. **Known family/model presets** — narrowly scoped rules apply only when a documented incompatibility is known.
3. **Safe error-driven retry** — when a provider explicitly reports a machine-readable/parseable token ceiling, or explicitly tells the client to use `max_completion_tokens` instead of `max_tokens`, the request is adjusted once and retried.

This means a newly released Qwen/GLM/Gemini/OpenAI-compatible model normally needs no plugin update. A new preset is only needed when a model family introduces a quirk that cannot be inferred safely from the generic protocol or the provider's error response.

## Current preset

### `glm-4v-flash*`

`glm-4v-flash` rejects output limits above 1024 tokens. The compatibility layer therefore caps the outgoing value at 1024 before the first request.

A stricter user setting is preserved:

```yaml
httpProviders:
  - name: glm
    baseURL: https://open.bigmodel.cn/api/paas/v4
    model: glm-4v-flash
    apiKeyEnv: ZHIPU_API_KEY
    maxTokens: 768
```

The request remains at 768. If `maxTokens` is 4096 (including the generic default), the GLM preset sends 1024.

## Image prompt compatibility

`vision_describe` always sends the image **and** its question to direct HTTP providers. Structured JSON mode also carries the full structured-output instruction. This avoids providers such as Zhipu GLM rejecting an image-only message with a missing-prompt error.

The JSON-correction retry keeps the original image + question message and adds the correction as a later user message, so context is not lost.

## Adaptive token retry

For otherwise unknown models, the first request stays generic. If the endpoint returns HTTP 400/422 and explicitly advertises a smaller output-token upper bound, vision-router lowers the token limit and retries once.

Examples of accepted error wording include:

```text
max_tokens参数非法：限制数值范围[1,1024]
max_tokens must be less than or equal to 2048
```

If an endpoint explicitly says that `max_tokens` is unsupported and instructs the client to use `max_completion_tokens`, vision-router switches the field and retries once.

The retry is intentionally conservative: it does not guess arbitrary provider parameters or repeatedly mutate a failing request.

## Adding a future preset

Presets live in `lib/http-compat.js` in `HTTP_PROVIDER_COMPAT_PRESETS`. Rules can match a model family and can also be extended to match provider/host information. Keep rules narrow and evidence-based; generic behavior should remain the default for unknown models.

Example shape:

```js
{
  id: 'example-family-output-cap',
  model: /^example-vl(?:$|[-_.])/i,
  maxTokensCap: 2048,
}
```

User-specified values that are already stricter than a preset cap are never increased.

## Scope

The compatibility fetch layer runs only inside vision-router-owned vision tools and the built-in `vision-http` adapter. It does not globally rewrite unrelated HTTP requests made by other DSH plugins.
