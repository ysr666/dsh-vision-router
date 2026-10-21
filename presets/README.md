# presets/ — runtime compatibility only

**DSH owns user provider/model registration, credentials and the model catalog.** Vision Router no longer maintains vendor-specific YAML examples, and the vision backend UI reads DSH's model list.

**Do not delete `web-connection-ready/`.** It is a real private Web/Host startup bridge loaded through `cordis.patch.yml`. [PR #676](https://github.com/ysr666/dsh-vision-router/pull/676) introduced it for DSH alpha.2: old `webRuntime` and new `webStartup` own different trusted-host readiness generations. It must survive packaging and remains until exact old/new Host tests justify removal.

[PR #89](https://github.com/ysr666/dsh-vision-router/pull/89) identified a genuine missing `image` declaration for custom DSH models. Prefer DSH model input types when available; for **verified visual models only**, older Hosts may need `llm-pi-ai` `input: [text, image]` and a reload. Verify actual image delivery with Test Vision instead of trusting metadata alone.

The built-in anonymous OVH fallback lives in `src/lib/core-primitives.js`'s `DEFAULT_HTTP_PROVIDERS`, not the old `presets/ovh.yaml` example. Retired example files can be read at [their original August 2026 commit](https://github.com/ysr666/dsh-vision-router/commit/16e29d07b943d2b2e1dfb615683ab07f24cc96af). See [architecture audit](../docs/architecture/model-catalog-ownership.md).
