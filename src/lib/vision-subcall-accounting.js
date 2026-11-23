/**
 * Process-local, bounded and privacy-minimal audit of REAL LLM streams
 * invoked inside a Vision Router tool execution. Does not touch native
 * Host/main/title streams or issue any new request.
 *
 * Never persist provider IDs, prompts, paths, account names, request IDs,
 * attachment data, tool arguments, raw errors or remote responses.
 * Multiple cumulative usage chunks count only their final cumulative value.
 */
const MAX_CALLS_PER_SESSION = 64

function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value : undefined
}
function usageOf(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const fields = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'totalTokens']
  const out = {}
  for (const key of fields) {
    const value = count(input[key])
    if (value !== undefined) out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}
function badFinish(value) {
  return value?.type === 'error' || value?.type === 'aborted' ||
    (value?.type === 'finish' &&
     (value.reason?.kind === 'error' || value.reason?.kind === 'aborted'))
}
export function createVisionSubcallAccounting() {
  const sessions = new WeakMap()
  return {
    observe(session, stream) {
      if (!session || typeof session !== 'object' ||
          !stream || typeof stream[Symbol.asyncIterator] !== 'function') return stream
      let state = sessions.get(session)
      if (!state) {
        state = { rows: [], truncated: false }
        sessions.set(session, state)
      }
      const record = { status: 'incomplete', usage: undefined }
      state.rows.push(record)
      if (state.rows.length > MAX_CALLS_PER_SESSION) {
        state.rows.shift()
        state.truncated = true
      }
      return (async function* () {
        let complete = false, failed = false
        try {
          for await (const chunk of stream) {
            if (chunk?.type === 'usage') {
              const value = usageOf(chunk.usage)
              if (value !== undefined) record.usage = value
            }
            if (badFinish(chunk)) failed = true
            if (chunk?.type === 'finish') complete = true
            yield chunk
          }
          record.status = failed ? 'failed' : complete ? 'finished' : 'incomplete'
        } catch (error) {
          record.status = 'failed'
          throw error
        } finally {
          // Early consumer return/abort means a request might still bill;
          // never report it as free or completed.
          if (record.status === 'incomplete' && failed) record.status = 'failed'
        }
      })()
    },
    snapshot(session) {
      const state = session && typeof session === 'object' ? sessions.get(session) : undefined
      if (!state) return { calls: 0, finished: 0, failed: 0, incomplete: 0,
        withUsage: 0, tokenTotals: null, truncated: false }
      const rows = state.rows
      const counts = {
        calls: rows.length,
        finished: rows.filter(x=>x.status==='finished').length,
        failed: rows.filter(x=>x.status==='failed').length,
        incomplete: rows.filter(x=>x.status==='incomplete').length,
        withUsage: rows.filter(x=>x.usage!==undefined).length,
        truncated: state.truncated,
      }
      const fieldNames = ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','totalTokens']
      // Partial Usage remains an explicit unknown, never silently zero.
      const totals = {}
      for (const name of fieldNames) {
        const values = rows.map(x=>x.usage?.[name])
        const valid = values.length > 0 && values.every(x=>x!==undefined)
        totals[name] = valid ? values.reduce((a,b)=>a+b,0) : null
      }
      return { ...counts, tokenTotals: rows.length>0?totals:null }
    },
  }
}
