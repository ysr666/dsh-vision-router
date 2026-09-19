export const VISION_SUCCESS_GUIDANCE =
  'Vision Router trusted execution metadata: the preceding vision_describe call SUCCEEDED. ' +
  'This metadata is not image content. If that successful evidence resolves the visual fact needed for the current task, stop making additional vision calls for that fact and continue the remaining user task from this evidence. ' +
  'If no non-visual work remains, answer now in exactly the format the user requested; when the user asks for only one value or short phrase, do not add Markdown, explanation, or a restatement. ' +
  'Call another vision tool only for a specific unresolved visual fact. For verbatim or exact-text tasks such as identifiers, amounts, times, version strings, or code, preserve every visible symbol, prefix, suffix, and punctuation from the most faithful evidence already collected; a later semantic summary must not overwrite a more exact transcription. Focused OCR or localization is still appropriate when character identity remains uncertain.'

function isVisionFailureEnvelope(value) {
  const text = value.trim()
  if (!text.startsWith('{')) return false
  try {
    const parsed = JSON.parse(text)
    return (
      parsed !== null &&
      typeof parsed === 'object' &&
      parsed.ok === false &&
      typeof parsed.code === 'string' &&
      /^VISION_[A-Z0-9_]+$/u.test(parsed.code)
    )
  } catch {
    return false
  }
}

export function visionDescribeSuccessContext(exec, result) {
  if (
    exec?.name !== 'vision_describe' ||
    !exec?.agent ||
    result?.isError !== false ||
    typeof result.value !== 'string' ||
    result.value.trim().length === 0 ||
    isVisionFailureEnvelope(result.value)
  ) return undefined
  return {
    role: 'user',
    id: `vision-router-evidence-success-${String(exec.callId)}`,
    content: [{ type: 'text', text: VISION_SUCCESS_GUIDANCE }],
    source: { kind: 'plugin', plugin: 'dsh-vision-router' },
  }
}
