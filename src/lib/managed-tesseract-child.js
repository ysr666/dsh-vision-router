// Only spawned by the owner-scoped OCR manager. The parent enforces
// input/output bounds, cancellation and a hard process deadline.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function main() {
  const [root] = process.argv.slice(2)
  if (!root) throw Error('missing managed Tesseract root')
  const data = []
  let length = 0
  for await (const part of process.stdin) {
    length += part.length
    if (length > 24 * 1024 * 1024) throw Error('OCR image too large')
    data.push(part)
  }
  const entry = pathToFileURL(join(root, 'node_modules', 'tesseract.js', 'src', 'index.js')).href
  const mod = await import(entry)
  const createWorker = mod.createWorker ?? mod.default?.createWorker
  if (typeof createWorker !== 'function') throw Error('missing managed Tesseract worker')
  let worker
  try {
    worker = await createWorker(['chi_sim', 'eng'], 1, {
      langPath: join(root, 'models'), gzip: true, cacheMethod: 'none', logger: () => {},
    })
    const result = await worker.recognize(Buffer.concat(data, length))
    process.stdout.write(JSON.stringify({
      text: String(result?.data?.text ?? '').slice(0, 32768),
      confidence: Number.isFinite(result?.data?.confidence) ? result.data.confidence : 0,
    }) + '\n')
  } finally { await worker?.terminate?.() }
}
main().catch(() => { process.stderr.write('managed Tesseract OCR failed\n'); process.exitCode = 1 })
