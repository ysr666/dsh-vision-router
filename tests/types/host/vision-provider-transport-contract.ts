import {
  createVisionProviderTransport,
  type VisionProviderTransport,
} from '../../../src/lib/vision-provider-transport.js'

const transport: Readonly<VisionProviderTransport> = createVisionProviderTransport({
  fetchImpl: async () => new Response('ok'),
})

const response: Promise<Response> = transport.fetch('https://example.com')
const disposed: Promise<void> = transport.dispose()
const credential: Promise<string | undefined> = transport.resolveCredential('TOKEN')
const errorText: Promise<string> = transport.readErrorText(new Response('failure'))
const modelJson: Promise<unknown> = transport.readModelJson(new Response('{"ok":true}'))
const decision = transport.proxyDecision('https://example.com')

const proxied: boolean = decision.proxied
const hostname: string | undefined = decision.hostname

void response
void disposed
void credential
void errorText
void modelJson
void proxied
void hostname
