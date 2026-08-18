import { realpathSync } from 'node:fs'
import path from 'node:path'

const wrappedContexts = new WeakMap()

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return nonEmptyString(cwd) ? cwd : process.cwd()
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function realpathOrResolve(value, realpath = realpathSync) {
  try {
    return realpath(value)
  } catch {
    return path.resolve(value)
  }
}

/**
 * Validate the screenshot source against the filesystem provider's canonical
 * containment relation. DSH targetKey is opaque and resolve() follows symlinks,
 * so consumers must not implement this trust boundary by parsing target ids.
 */
export async function assertScreenshotSourceInWorkspace(ctx, core, source, exec, options = {}) {
  const fsService = ctx?.get?.('fs')
  if (!fsService || typeof fsService.resolve !== 'function') {
    throw new Error('vision_html_screenshot: the fs service is not available')
  }
  const workspace = workspaceOf(exec)
  const signal = exec?.signal
  // The path interpretation root must be the same root we authorize below.
  // Otherwise a provider with a different default cwd could resolve a relative
  // source somewhere else and only later be checked against the session cwd.
  const sourceTarget = await fsService.resolve(source, { cwd: workspace, signal })

  if (sourceTarget && typeof sourceTarget === 'object' && typeof fsService.contains === 'function') {
    let workspaceTarget
    try {
      workspaceTarget = await fsService.resolve(workspace, { signal })
      if (fsService.contains(workspaceTarget, sourceTarget) !== true) {
        throw new Error('vision_html_screenshot: source must stay inside the session workspace')
      }
      return sourceTarget
    } catch (error) {
      if (error?.message === 'vision_html_screenshot: source must stay inside the session workspace') throw error
      const wrapped = new Error('vision_html_screenshot: could not verify source containment in the session workspace')
      wrapped.cause = error
      throw wrapped
    }
  }

  // Legacy/string FS compatibility. realpath resolves symlinks before the
  // containment check, so a workspace-owned symlink cannot authorize a secret
  // file outside the workspace.
  const realpath = options.realpathSync ?? realpathSync
  const targetPath = core?.toRealPath?.(fsService, sourceTarget)
  if (!nonEmptyString(targetPath)) {
    throw new Error('vision_html_screenshot: could not resolve source to a process path')
  }
  const workspaceReal = realpathOrResolve(workspace, realpath)
  const targetReal = realpathOrResolve(targetPath, realpath)
  if (!pathInside(workspaceReal, targetReal)) {
    throw new Error('vision_html_screenshot: source must stay inside the session workspace')
  }
  return sourceTarget
}

function wrapTools(tools, ctx, core) {
  if (!tools || (typeof tools !== 'object' && typeof tools !== 'function')) return tools
  return new Proxy(tools, {
    get(target, property) {
      if (property !== 'register') {
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
      const register = Reflect.get(target, property, target)
      if (typeof register !== 'function') return register
      return (def) => {
        if (def?.name !== 'vision_html_screenshot' || typeof def.execute !== 'function') {
          return register.call(target, def)
        }
        const execute = def.execute
        return register.call(target, {
          ...def,
          async execute(args, exec) {
            const source = String(args?.source ?? '')
            await assertScreenshotSourceInWorkspace(ctx, core, source, exec)
            return execute(args, exec)
          },
        })
      }
    },
  })
}

/**
 * Install inside the browser hardening wrapper. The outer hardening layer
 * replaces vision_html_screenshot.execute with its secure Chrome renderer, then
 * this inner tools.register boundary wraps that final execute with FS authority.
 */
export function installScreenshotSourceBoundary(ctx, core) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return ctx
  const cached = wrappedContexts.get(ctx)
  if (cached) return cached
  let wrapped
  wrapped = new Proxy(ctx, {
    get(target, property) {
      if (property === 'tools') return wrapTools(target.tools, wrapped, core)
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  wrappedContexts.set(ctx, wrapped)
  return wrapped
}
