import { readFile, writeFile } from 'node:fs/promises'

const file = new URL('../index.js', import.meta.url)
let source = await readFile(file, 'utf8')

function replaceOnce(label, before, after) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`)
  source = source.replace(before, after)
}

replaceOnce(
  'recover evicted attachment by target id',
  `  const lookupAttachment = (session, id) => {\n    let hit = visionState.lookupAttachment(session, id)\n    if (hit !== undefined) return hit\n    // Cache eviction is a performance event, never a correctness event: the\n    // durable session log remains authoritative and can repopulate the ref.\n    if (session !== undefined) {\n      scanSessionEventLog(session)\n      hit = visionState.lookupAttachment(session, id)\n      if (hit !== undefined) return hit\n    }\n    return undefined\n  }`,
  `  const lookupAttachment = (session, id) => {\n    let hit = visionState.lookupAttachment(session, id)\n    if (hit !== undefined) return hit\n    // Cache eviction is a performance event, never a correctness event. First\n    // consume any newly appended log entries; if the requested ref was older\n    // than the bounded working set, perform a target-only recovery from the\n    // durable session log instead of rebuilding an unbounded index.\n    if (session !== undefined) {\n      scanSessionEventLog(session)\n      hit = visionState.lookupAttachment(session, id)\n      if (hit !== undefined) return hit\n      let events\n      try {\n        events = session.events\n      } catch {\n        events = undefined\n      }\n      if (Array.isArray(events) && events.length > 0) {\n        const wanted = String(id)\n        const recovered = collectEventAttachmentRefs(events).find(\n          (ref) => ref && String(ref.attachmentId) === wanted,\n        )\n        if (recovered !== undefined) {\n          visionState.recordAttachments(session, [recovered])\n          return recovered\n        }\n      }\n    }\n    return undefined\n  }`,
)

replaceOnce(
  'bind pre-step memory to the current session',
  `    const session = payload.agent && payload.agent.session\n    if (!session) return decision\n    // Bind the turn-scoped failure memory for this session+turn:`,
  `    const session = payload.agent && payload.agent.session\n    if (!session) return decision\n    // #208: every pre-step read/write is scoped to the durable conversation\n    // owner. The global compatibility facade is reserved for adapter stream\n    // boundaries where DSH does not expose a Session object.\n    const sessionImageMemory = visionState.memoryForSession(session)\n    // Bind the turn-scoped failure memory for this session+turn:`,
)

replaceOnce(
  'scope instant local caption memory',
  `            const instantMap = await buildInstantLocalMap(ctx, messages, localProviders, {\n              style: instantLocalStyle(),\n              memory: imageMemory,\n              timeoutMs: timeoutMs(),`,
  `            const instantMap = await buildInstantLocalMap(ctx, messages, localProviders, {\n              style: instantLocalStyle(),\n              memory: sessionImageMemory,\n              timeoutMs: timeoutMs(),`,
)

replaceOnce(
  'scope reminder history rewrite',
  `              ? rewriteHistoryImages(messages, imageMemory).messages\n              : messages`,
  `              ? rewriteHistoryImages(messages, sessionImageMemory).messages\n              : messages`,
)

replaceOnce(
  'scope image turn history rewrite',
  `        const rewrittenHistory = rewriteHistoryImages(messages, imageMemory).messages`,
  `        const rewrittenHistory = rewriteHistoryImages(messages, sessionImageMemory).messages`,
)

replaceOnce(
  'scope text turn history rewrite',
  `      const cleaned = rewriteHistoryImages(base, imageMemory)`,
  `      const cleaned = rewriteHistoryImages(base, sessionImageMemory)`,
)

replaceOnce(
  'scope structured bootstrap memory',
  `        for (const id of ids) imageMemory.set(id, memory)`,
  `        const scopedMemory = session ? visionState.memoryForSession(session) : imageMemory\n        for (const id of ids) scopedMemory.set(id, memory)`,
)

replaceOnce(
  'mark follow-up integration',
  `  const imageMemory = visionState.descriptionFacade`,
  `  const imageMemory = visionState.descriptionFacade\n  // #208 follow-up complete: session-visible paths use scoped memory; only\n  // session-less adapter boundaries use the ambiguity-safe facade.`,
)

await writeFile(file, source)
console.log('issue 208 session follow-up applied')
