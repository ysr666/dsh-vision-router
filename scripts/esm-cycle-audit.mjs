import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SourceTextModule } from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))

async function collectModules(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectModules(child))
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(child)
  }
  return files
}

function display(file) {
  return relative(root, file).replaceAll('\\\\', '/')
}

function moduleSpecifiers(source, identifier) {
  const module = new SourceTextModule(source, { identifier })
  if (Array.isArray(module.dependencySpecifiers)) return module.dependencySpecifiers
  if (Array.isArray(module.moduleRequests)) {
    return module.moduleRequests
      .map((request) => typeof request === 'string' ? request : request?.specifier)
      .filter(Boolean)
  }
  throw new Error('Node vm.SourceTextModule exposes no static dependency list')
}

const files = [
  resolve(root, 'index.js'),
  resolve(root, 'entry.js'),
  ...await collectModules(resolve(root, 'lib')),
]
const known = new Set(files)
const graph = new Map(files.map((file) => [file, []]))
const unresolved = []

for (const file of files) {
  const source = await readFile(file, 'utf8')
  for (const specifier of moduleSpecifiers(source, file)) {
    if (!specifier.startsWith('.')) continue
    const base = resolve(dirname(file), specifier)
    const choices = extname(base)
      ? [base]
      : [`${base}.js`, `${base}.mjs`, resolve(base, 'index.js')]
    const target = choices.find((choice) => known.has(choice))
    if (target) graph.get(file).push(target)
    else if (!extname(base) || /\.(?:js|mjs)$/.test(base)) {
      unresolved.push(`${display(file)} -> ${specifier}`)
    }
  }
}

if (unresolved.length) {
  console.error(
    'Unresolved production ESM imports:\n' +
    unresolved.sort().map((edge) => `- ${edge}`).join('\n'),
  )
  process.exitCode = 1
} else {
  let nextIndex = 0
  const indices = new Map()
  const low = new Map()
  const stack = []
  const stacked = new Set()
  const components = []

  function visit(node) {
    indices.set(node, nextIndex)
    low.set(node, nextIndex)
    nextIndex += 1
    stack.push(node)
    stacked.add(node)

    for (const target of graph.get(node)) {
      if (!indices.has(target)) {
        visit(target)
        low.set(node, Math.min(low.get(node), low.get(target)))
      } else if (stacked.has(target)) {
        low.set(node, Math.min(low.get(node), indices.get(target)))
      }
    }

    if (low.get(node) !== indices.get(node)) return
    const component = []
    while (stack.length) {
      const current = stack.pop()
      stacked.delete(current)
      component.push(current)
      if (current === node) break
    }
    components.push(component)
  }

  for (const file of files) if (!indices.has(file)) visit(file)

  const cycles = components.filter(
    (component) => component.length > 1 || graph.get(component[0]).includes(component[0]),
  )
  const edgeCount = [...graph.values()].reduce((sum, edges) => sum + edges.length, 0)

  if (cycles.length) {
    console.error('Static production ESM cycles detected:')
    for (const cycle of cycles) {
      console.error('- ' + cycle.map(display).sort().join(' <-> '))
    }
    process.exitCode = 1
  } else {
    console.log(
      `ESM cycle audit: ${files.length} modules, ${edgeCount} static relative edges, 0 cycles`,
    )
  }
}
