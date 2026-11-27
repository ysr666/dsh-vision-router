// Diagnostic Host proposal only. Never run against a user's installed Host.
// All mutations stay in a disposable pinned Host checkout in the CI job.
import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const expected = new Set(['9c2670d3bce5275e0d1610272958121af87787bb','4b399c39a6d1479cd84ca591b4d7c88e24d38a96'])
assert.ok(expected.has(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()))
assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}),'')
const path = 'packages/api/session-controller/src/commands.ts'
const testPath = 'packages/api/session-controller/tests/commands-upload-file.host.spec.ts'
let source = readFileSync(path,'utf8')
function replace(before,after) {
  assert.equal(source.split(before).length,2,'exact source anchor: '+before)
  source=source.replace(before,after)
}
replace("type PromptContentCandidate =", `// Candidate extension: permission to admit a durable image whose pixels the
// selected text model does NOT consume. The native modality remains truthful.
// No handler is equivalent to the existing default denial.
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode bail */
    'session/allow-projected-image'(agent: Agent, selection: Readonly<Pick<AgentModelSelection, 'provider' | 'model'>>): true | undefined
  }
}

type PromptContentCandidate =`)
replace("    const admit = async (): Promise<SessionPromptValue> => {",`    const admit = async (): Promise<SessionPromptValue> => {
      let projectedSelection: Readonly<Pick<AgentModelSelection, 'provider' | 'model'>> | undefined
      const requireProjectedImagePermission = () => {
        if (projectedSelection === undefined) return
        const current = agent.model.current()
        if (current?.provider === projectedSelection.provider
          && current.model === projectedSelection.model
          && this.ctx.bail('session/allow-projected-image', agent, projectedSelection) === true) return
        throw new RemoteError(
          'session/attachment-invalid',
          \`Model "\${projectedSelection.model}" does not support image input.\`,
          { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
        )
      }`)
const refusal = `              throw new RemoteError(
                'session/attachment-invalid',
                \`Model "\${current.model}" does not support image input.\`,
                { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
              )`
replace(refusal,`              projectedSelection = Object.freeze({ provider: current.provider, model: current.model })
              // Only a text-capable route can use the existing text projection.
              if (!model.inputModalities.includes('text')) {
${refusal}
              }
              requireProjectedImagePermission()`)
replace("        using binding = this.ctx.fileUploads.bindPrompt(agent, admission.receiptIds, request.requestId)",`        // Storage is asynchronous. Re-check the live permission immediately
        // before publishing a message or binding a receipt, not only before I/O.
        requireProjectedImagePermission()
        using binding = this.ctx.fileUploads.bindPrompt(agent, admission.receiptIds, request.requestId)`)
writeFileSync(path,source)
const extra = `

describe('diagnostic projected-image admission contract', () => {
  const textInfo = { provider: 'fixture', id: 'fixture-model', name: 'Fixture', inputModalities: ['text'] }
  it('preserves default refusal and accepts only exact live scope, with idempotent receipt retry', async () => {
    const { ctx, controller, uploads, agent, followup, saveImages, resolveModelInfo } = await uploadHarness()
    resolveModelInfo.mockResolvedValue(textInfo)
    saveImages.mockResolvedValue([STAGED_IMAGE])
    const receipt = await uploads.uploadImageStream({ sessionId: SESSION, data: chunks([1]), mediaType: 'image/png' })
    const request = promptRequest([{ type: 'file', receiptId: receipt.receiptId }])
    await expect(controller.prompt(request, USER_SOURCE)).rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } })
    const offWrong = ctx.on('session/allow-projected-image', (receiver) => receiver.id === 'another-session' ? true : undefined)
    await expect(controller.prompt(request, USER_SOURCE)).rejects.toMatchObject({ code: 'session/attachment-invalid' })
    offWrong()
    const off = ctx.on('session/allow-projected-image', (receiver, selection) =>
      receiver === agent && selection.provider === 'fixture' && selection.model === 'fixture-model' ? true : undefined)
    await expect(controller.prompt(request, USER_SOURCE)).resolves.toEqual({ accepted: true })
    off()
    await expect(controller.prompt(request, USER_SOURCE)).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledTimes(1)
    expect((followup.mock.calls[0]?.[0] as UserMessage).content).toEqual([{ type: 'image', attachment: STAGED_IMAGE }])
    expect(saveImages).toHaveBeenCalledTimes(1)
    expect(agent.model.current()?.provider).toBe('fixture')
    expect(agent.model.current()?.model).toBe('fixture-model')
  })

  it('rechecks revocation after asynchronous image admission before inbox publication', async () => {
    const { ctx, controller, followup, saveImages, resolveModelInfo } = await uploadHarness()
    resolveModelInfo.mockResolvedValue(textInfo)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    saveImages.mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return [STAGED_IMAGE]
    })
    const off = ctx.on('session/allow-projected-image', () => true)
    const result = controller.prompt(promptRequest([{ type: 'image', mediaType: 'image/png', data: 'AAAA' }]), USER_SOURCE)
    const refusal = expect(result).rejects.toMatchObject({ code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } })
    await entered.promise
    off()
    release.resolve()
    await refusal
    expect(followup).not.toHaveBeenCalled()
  })

  it('never grants a non-text, non-image route and never requires extension permission for a native image route', async () => {
    const { ctx, controller, followup, saveImages, resolveModelInfo } = await uploadHarness()
    saveImages.mockResolvedValue([STAGED_IMAGE])
    const request = promptRequest([{ type: 'image', mediaType: 'image/png', data: 'AAAA' }])
    const off = ctx.on('session/allow-projected-image', () => true)
    resolveModelInfo.mockResolvedValue({ ...textInfo, inputModalities: ['audio'] })
    await expect(controller.prompt(request, USER_SOURCE)).rejects.toMatchObject({ code: 'session/attachment-invalid' })
    off()
    resolveModelInfo.mockResolvedValue({ ...textInfo, inputModalities: ['text', 'image'] })
    await expect(controller.prompt(request, USER_SOURCE)).resolves.toEqual({ accepted: true })
    expect(followup).toHaveBeenCalledTimes(1)
  })
})
`
writeFileSync(testPath,readFileSync(testPath,'utf8')+extra)
execFileSync('git',['diff','--check'],{stdio:'inherit'})
