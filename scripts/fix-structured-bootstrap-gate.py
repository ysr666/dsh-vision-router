from pathlib import Path

root = Path(__file__).resolve().parents[1]

def patch(path, old, new):
    p = root / path
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count == 0 and new in text:
        return False
    if count != 1:
        raise RuntimeError(f'{path}: expected one match, got {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')
    return True

changed = False
changed |= patch(
    'index.js',
    "      hasImage &&\n      structuredBootstrapEnabled() &&\n      structuredBootstrapPromptedTurn.get(session) !== payload.turn",
    "      hasImage &&\n      toolEnabled() &&\n      structuredBootstrapEnabled() &&\n      structuredBootstrapPromptedTurn.get(session) !== payload.turn",
)
changed |= patch(
    'index.js',
    "        if (!structuredBootstrapEnabled()) {\n          return JSON.stringify({",
    "        if (!toolEnabled() || !structuredBootstrapEnabled()) {\n          return JSON.stringify({",
)
changed |= patch(
    'lib/client.js',
    "        '这是 1+x，不是固定 1+1；会让图片任务至少增加 1 次视觉请求。',",
    "        '这是 1+x，不是固定 1+1；需保持「识图工具」开启，并会让图片任务至少增加 1 次视觉请求。',",
)
changed |= patch(
    'lib/client.js',
    "        'other vision tools as needed. This is 1+x, not a fixed 1+1 flow, and adds at least one vision request to image tasks.',",
    "        'other vision tools as needed. This is 1+x, not a fixed 1+1 flow; keep Vision tools enabled. It adds at least one vision request to image tasks.',",
)
changed |= patch(
    'tests/structured-bootstrap.test.js',
    "  assert.equal(index.includes('structuredBootstrapPromptedTurn'), true)\n",
    "  assert.equal(index.includes('structuredBootstrapPromptedTurn'), true)\n  assert.equal(index.includes('hasImage &&\\n      toolEnabled() &&\\n      structuredBootstrapEnabled()'), true)\n",
)
print('changed' if changed else 'already applied')
