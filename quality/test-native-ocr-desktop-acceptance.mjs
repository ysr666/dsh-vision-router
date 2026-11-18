import test from 'node:test'
import assert from 'node:assert/strict'
import { readNativeOcrToolResult, OCR_TOOL_CALL_ID } from './native-ocr-desktop-acceptance.mjs'

const result = { engine: 'ncnn', text: 'TEST 123', uncertain: false }
const row = (value, id = OCR_TOOL_CALL_ID) => ({ role: 'tool', tool_call_id: id, content: JSON.stringify(value) })
test('exact tool call is correlated and selected ncnn must be proven', () => {
  assert.deepEqual(readNativeOcrToolResult([row(result)], 'TEST 123'), result)
  assert.equal(readNativeOcrToolResult([{ role: 'user', content: JSON.stringify(result) }, row(result, 'other')], 'TEST 123'), null)
  assert.throws(() => readNativeOcrToolResult([row({ ...result, engine: 'tesseract' })], 'TEST 123'), /installed ncnn/)
  assert.throws(() => readNativeOcrToolResult([row({ ...result, text: 'TEST 124' })], 'TEST 123'))
  assert.throws(() => readNativeOcrToolResult([row(result), row(result)], 'TEST 123'), /one correlated/)
})
test('native result may be canonical text blocks but never a string search', () => {
  assert.deepEqual(readNativeOcrToolResult([{ ...row(result), content: [{ type: 'text', text: JSON.stringify(result) }] }], 'TEST 123'), result)
  assert.throws(() => readNativeOcrToolResult([{ ...row(result), content: 'prefix ' + JSON.stringify(result) }], 'TEST 123'))
})
