from pathlib import Path

index = Path('index.js')
text = index.read_text()

old = "    }, 'vision-router: test-connection route')\n  })\n\n  // Install-method-agnostic update status for the settings card."
new = "    }, 'vision-router: test-connection route')\n\n  // Install-method-agnostic update status for the settings card."
assert text.count(old) == 1, text.count(old)
text = text.replace(old, new, 1)

marker = "  // Install-method-agnostic update status for the settings card."
head, tail = text.split(marker, 1)
opening = "  ctx.inject(['webServer'], (webCtx) => {\n    webCtx.effect("
assert tail.count(opening) == 3, tail.count(opening)
tail = tail.replace(opening, "    webCtx.effect(", 3)

for label in ('vision-router: update-check route', 'vision-router: self-update route'):
    old_close = f"      '{label}',\n    )\n  }})"
    new_close = f"      '{label}',\n    )"
    assert tail.count(old_close) == 1, (label, tail.count(old_close))
    tail = tail.replace(old_close, new_close, 1)

text = head + marker + tail
assert text.count("ctx.inject(['webServer']") == 1, text.count("ctx.inject(['webServer']")
for route in (
    '/_dsh/vision-router/test-connection',
    '/_dsh/vision-router/update-check',
    '/_dsh/vision-router/self-update',
    '/_dsh/vision-router/model-capabilities',
):
    assert route in text, route
index.write_text(text)

test_path = Path('tests/host-route-registration.test.js')
test_path.write_text("""import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\n\nconst source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')\n\ntest('all Vision Router host endpoints share one webServer injection', () => {\n  // DSH 0.1.0-rc.6 + the local-vision stabilizer only retained the first of\n  // repeated wrapped webServer injections. Keep the four host endpoints in\n  // one injection fiber so route registration is atomic across rc.6 and later.\n  assert.equal((source.match(/ctx\\.inject\\(\\['webServer'\\]/g) || []).length, 1)\n  const injection = source.indexOf(\"ctx.inject(['webServer']\")\n  const boundary = source.indexOf('// Expose the namespace to the web configuration boundary.')\n  assert.ok(injection >= 0)\n  assert.ok(boundary > injection)\n  for (const route of [\n    '/_dsh/vision-router/test-connection',\n    '/_dsh/vision-router/update-check',\n    '/_dsh/vision-router/self-update',\n    '/_dsh/vision-router/model-capabilities',\n  ]) {\n    const position = source.indexOf(route)\n    assert.ok(position > injection && position < boundary, `${route} must be registered in the shared injection`)\n  }\n})\n""")
