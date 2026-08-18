import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../index.js', import.meta.url)
let source = await readFile(file, 'utf8')

const before = `// 跨轮图片描述记忆（attachmentId -> description）：写入跨轮缓存，同图\n// 后续轮次直接命中、不重复识别。保持 main 的无界语义（见 imageMemorySet）。\nexport function imageMemorySet(map, id, description) {\n  // Keep main's unbounded memory semantics: a global FIFO cap here would make\n  // long sessions of users who never enabled local vision forget earlier\n  // images (a behavior change outside local-vision scope). If memory bounding\n  // is ever wanted, it must be its own explicit policy, not a side effect of\n  // the local backend merge.\n  return map.set(id, description)\n}`

const after = `// 跨轮图片描述记忆（attachmentId -> description）：调用方传入当前会话的\n// bounded Map view；同图后续轮次直接命中、不重复识别。这个 helper 本身不再\n// 决定生命周期策略，owner / LRU / text budget 统一由 SessionVisionStateStore 管理。\nexport function imageMemorySet(map, id, description) {\n  return map.set(id, description)\n}`

const count = source.split(before).length - 1
if (count !== 1) throw new Error(`expected one legacy imageMemorySet comment, found ${count}`)
source = source.replace(before, after)
await writeFile(file, source)
console.log('issue 208 polish applied')
