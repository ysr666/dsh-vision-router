import assert from 'node:assert/strict'

// Correlate only the actual tool response with the requested call, never a
// matching string in the user's prompt or a previous assistant message.
export const OCR_TOOL_CALL_ID = 'desktop-e2e-native-ocr-call'
export const OCR_PROMPT_MARKER = 'DVR_EXACT_NATIVE_OCR_PROBE'
export const OCR_RENDERED_MARKER = 'DESKTOP_NATIVE_OCR_E2E_OK'

export function readNativeOcrToolResult(messages, expected) {
  const matches = messages.filter(row => row?.role === 'tool' && row.tool_call_id === OCR_TOOL_CALL_ID)
  if (!matches.length) return null
  assert.equal(matches.length, 1, 'expected one correlated native OCR result')
  const content = matches[0].content
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text).join('') : ''
  const result = JSON.parse(text)
  assert.equal(result.engine, 'ncnn', 'Host tool must select installed ncnn, not a fallback')
  assert.equal(typeof result.text, 'string')
  assert.equal(result.text.replace(/\s+/g, ''), expected.replace(/\s+/g, ''))
  return { engine: result.engine, text: result.text, uncertain: result.uncertain === true }
}
