import { readFileSync, writeFileSync } from 'node:fs'

const path = 'index.js'
let source = readFileSync(path, 'utf8')

function replaceOnce(input, before, after, label) {
  const first = input.indexOf(before)
  if (first === -1) {
    if (input.includes(after)) return input
    throw new Error(`patch anchor not found: ${label}`)
  }
  if (input.indexOf(before, first + before.length) !== -1) {
    throw new Error(`patch anchor is ambiguous: ${label}`)
  }
  return input.slice(0, first) + after + input.slice(first + before.length)
}

source = replaceOnce(
  source,
  "import { promisify } from 'node:util'\n",
  "import { promisify } from 'node:util'\n" +
    "import { appendPromptToImageOnlyMessage, fetchWithOpenAICompatibility } from './lib/http-compat.js'\n",
  'http compatibility import',
)

const normalizeDetectAnchor = `/**
 * Normalize a vision_detect model answer into the canonical shape, clamping
 * every box into the image bounds. Returns undefined when the JSON is not a
 * usable inventory.
 */
export function normalizeDetectResult(parsed, width, height) {`
const promptHelper = `/** Shared vision_describe prompt for adapter and direct-HTTP paths. */
export function visionDescribePrompt(question, wantJson = false) {
  const text = String(question ?? '')
  return wantJson ? text + '\\n\\n' + describeStructuredInstruction(text) : text
}

`
source = replaceOnce(
  source,
  normalizeDetectAnchor,
  promptHelper + normalizeDetectAnchor,
  'visionDescribePrompt helper',
)

const oldPromptBlock = `        const question = String(args.question ?? '')
        const wantJson = args.json === true
        // Structured JSON mode: a fixed evidence contract (summary + reading-
        // order layout regions + entity inventory + verbatim transcription)
        // instead of a free-form JSON the model invents on the fly.
        const jsonInstruction = wantJson
          ? '\\n\\n' + describeStructuredInstruction(question)
          : ''`
const newPromptBlock = `        const question = String(args.question ?? '')
        const wantJson = args.json === true
        // Keep the adapter path and direct OpenAI-compatible HTTP path on the
        // exact same prompt, including the structured JSON evidence contract.
        const promptText = visionDescribePrompt(question, wantJson)`
source = replaceOnce(source, oldPromptBlock, newPromptBlock, 'vision_describe prompt construction')

source = replaceOnce(
  source,
  "            content: [...blocks, { type: 'text', text: question + jsonInstruction }],",
  "            content: [...blocks, { type: 'text', text: promptText }],",
  'adapter vision_describe prompt',
)

const oldHttpAsk = `            const askHttp = async (correction) => {
              const content = correction === undefined ? openAIBlocks : [{ type: 'text', text: correction }]
              const answer = await callOpenAICompatible(
                provider,
                correction === undefined
                  ? [{ role: 'user', content }]
                  : [
                      { role: 'user', content: openAIBlocks },
                      { role: 'user', content: [{ type: 'text', text: correction }] },
                    ],
                { maxTokens: provider.maxTokens ?? 4096, signal, resolveCredential },
              )
              return answer
            }`
const newHttpAsk = `            // Direct HTTP providers must receive the same image + question as
            // adapter-backed providers. Some endpoints (e.g. Zhipu GLM) reject
            // a pure-image user message even when permissive endpoints accept it.
            const openAIBaseMessages = appendPromptToImageOnlyMessage(
              [{ role: 'user', content: openAIBlocks }],
              promptText,
            ).messages
            const askHttp = async (correction) => {
              const answer = await callOpenAICompatible(
                provider,
                correction === undefined
                  ? openAIBaseMessages
                  : [
                      ...openAIBaseMessages,
                      { role: 'user', content: [{ type: 'text', text: correction }] },
                    ],
                { maxTokens: provider.maxTokens ?? 4096, signal, resolveCredential },
              )
              return answer
            }`
source = replaceOnce(source, oldHttpAsk, newHttpAsk, 'direct HTTP vision_describe messages')

const oldRequest = `  const request = () =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })`
const newRequest = `  const request = () =>
    fetchWithOpenAICompatibility(
      fetch,
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      { active: true, providerName: provider.name },
    )`
source = replaceOnce(source, oldRequest, newRequest, 'OpenAI-compatible request compatibility')

writeFileSync(path, source)
