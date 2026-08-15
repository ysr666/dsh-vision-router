from pathlib import Path
import re

path = Path('lib/client.js')
text = path.read_text()
pattern = re.compile(r'<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> origin/main\n', re.S)
blocks = list(pattern.finditer(text))
if len(blocks) != 3:
    raise SystemExit(f'expected exactly 3 client conflicts, got {len(blocks)}')


def resolve(match):
    ours, main = match.group(1), match.group(2)
    joined = ours + main
    if "onboardingTitle" in joined and "先分清" in main:
        out = main.replace('先分清：聊天的模型 ≠ 看图的模型 👁️', '先分清：聊天的模型 ≠ 看图的模型 🎉')
        out = out.replace(
            "onboardingStep3Body: '视觉后端链第一行是主视觉模型；后面的行只在失败时依次回退。默认内置免费视觉模型通常可以直接使用。',",
            "onboardingStep3Body: '视觉后端链每一行都是你自己的视觉模型，从上到下依次尝试；可以全部留空。内置 OVH 匿名免费链固定在最后自动兜底。',",
        )
        return out
    if "onboardingTitle" in joined and "First: the chat model" in main:
        out = main.replace('First: the chat model ≠ the vision model 👁️', 'First: the chat model ≠ the vision model 🎉')
        out = out.replace(
            "onboardingStep3Body: 'The first row in the vision backend chain is primary; later rows are tried only on failure. The built-in free vision model is usually fine as the default.',",
            "onboardingStep3Body: 'Each row in the vision backend chain is one of your own vision models and is tried top to bottom. You may leave every row empty; the built-in anonymous OVH chain remains the automatic final fallback.',",
        )
        return out
    if 'builtinFallbackPanel()' in ours and 'guideActive' in main:
        # main keeps #61's guide wrapper for the manual-input fallback; the
        # normal chainEditor already owns the same guide target. Then append
        # our fixed OVH fallback card below either editor.
        return main + '              builtinFallbackPanel(),\n'
    raise SystemExit('unrecognized conflict block')

text = pattern.sub(resolve, text)
if any(marker in text for marker in ('<<<<<<<', '=======', '>>>>>>>')):
    raise SystemExit('conflict marker remains in lib/client.js')

# #61's guided callout still described the old “row 1 = built-in free model”
# mental model. Keep its guide UI but align the copy with fixed OVH fallback.
text = text.replace(
    "guideChainBody: '第一行 = 主视觉模型；后面的行 = 失败时备用。这里不会修改聊天页右下角的会话/文字模型。选好后点击页面底部「保存」。',",
    "guideChainBody: '上面的每一行都是你自己的视觉模型，从上到下依次尝试；可以全部留空。内置 OVH 免费链固定在最后自动兜底。这里不会修改聊天页右下角的会话/文字模型。选好后点击页面底部「保存」。',",
)
text = text.replace(
    "guideChainBody: 'First row = primary vision model; later rows = fallbacks. This does not change the session/text model in the lower-right chat selector. Click “Save” at the bottom after choosing.',",
    "guideChainBody: 'Each row above is one of your own vision models, tried top to bottom; you may leave them all empty. The built-in OVH chain remains the automatic final fallback. This does not change the session/text model in the lower-right chat selector. Click “Save” after choosing.',",
)
path.write_text(text)
