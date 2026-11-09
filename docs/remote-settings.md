# Vision Router settings: one configuration, two Host transports

Vision Router has **one** Host-owned `vision-router` configuration namespace and
one schema, revision check and persistence authority. It needs two transport
adapters for historical DSH browser APIs, **not two different sets of editable
configuration fields**:

- **Local Web / official Desktop:** `settingsScope` when supported, otherwise
  the local ConfigEditor-backed `/_dsh/vision-router/local-settings` bridge.
  The latter is strictly local-only and checks both transport provenance and
  the Host's authenticated browser-session rejection result before any read or
  write. No user-facing remote risk prompt is needed.
- **Remote Web:** `/vision-router-settings/*` over DSH Connection RPC.
  The authenticated Host carrier is mandatory, and the first disabled
  `describe` triggers the user's explicit risk notice. Accepting persists
  `allowRemoteSettings=true` in the Host profile and immediately refreshes
  the settings. Once enabled, ordinary DVR configuration fields have the same
  editability as on the local page.

The remote transport does **not** maintain a separate capability allow-list for
ordinary configuration. Network and proxy overrides, local Ollama / LM Studio
definitions, HTTP provider settings, route names, desktop screenshot preference
and the `localOnlyVision` privacy switch use the same Host schema and
authoritative revisioned mutation path after the acknowledgement. The local-only
privacy switch is visible remotely, so take special care when changing it:
disabling it can permit image traffic to cloud vision providers. A remote change
does not itself grant operating-system screen-recording permission.

`allowRemoteSettings` itself is **not** an ordinary remote mutation: it is
enabled by the risk-confirmation flow and can be revoked from the local settings
page. It remains opt-in and off by default. Revocation takes effect on the
next RPC request; it does not erase the prior acknowledgement from history.
The acknowledgement is a UX safeguard, **not authentication or proof of local
presence**. DSH `trustedHosts` alone is likewise *not* authentication.
Browser-session authentication, Host/Origin policy, and the Connection RPC
contract are the actual access controls.

## Sensitive information and remaining local capabilities

Settings descriptions are requested from DSH with
`describe({ redactSecrets: true })`. The remote view additionally masks
secret-shaped properties and URL username/password and secret query parameters
(e.g., in a proxy URL). API-key environment names such as `apiKeyEnv` are
references, not actual credential values. A just-submitted secret-bearing field
may be echoed **only** in that caller's successful, exact-value write response
to support readback; subsequent reads remain redacted. If editing a URL
containing masked username/password or secret query parameters, re-enter
those values first: the server rejects saving a redaction placeholder rather
than silently replacing the real credential. Never treat the complete
settings view as a credential-export endpoint.

A full settings editor **does not** grant access to separate Host capabilities
such as reading/opening log files, plugin self-update, local connection probes,
local diagnostic mutation endpoints, local file access, or OS permission
prompts. Those routes retain independent server-side local-only restrictions.
The `/_dsh/vision-router/local-settings` compatibility endpoint is not an
alternate remote route and must never be forwarded for external use.

## DSH transport compatibility and proxy security

Legacy DSH Connection RPC requires the explicit
`{ authority: 'trusted-host' }` registration option; modern DSH uses
`connection.requestRejection()` and Host-owned BrowserAuth/Origin checks with
a two-argument `rpc.handle()`. DVR feature-detects this semantic contract.
Neither case exposes unauthenticated remote configuration.

If using Nginx/Caddy, forward `/vision-router-settings/*` to the same DSH origin
as the rest of the app. A 404 on this channel means the proxy or plugin runtime
has not registered/forwarded that route, **not** that the risk prompt needs to be
clicked again.

Follow the [official DSH reverse proxy deployment contract](https://github.com/deepseek-ai/deepseek-harness/blob/d743267388641bc76f17c45ce8b4c231aed1d32c/docs/user/guide/public-deployments.md):
preserve the browser-facing `Host`, explicitly configure trusted hosts, and
use HTTPS. The Host's signed browser session authenticates accepted requests
but cannot prove a user is physically present at the machine. A reverse proxy
that changes the Host to localhost and removes all forwarding provenance can
defeat software-only local-presence inference; do not expose that topology.
See [Issue #680](https://github.com/ysr666/dsh-vision-router/issues/680).

## Regression coverage

The settings contract tests cover both compatibility-wrapper load orders
(Issue #822), local ConfigEditor read/write/reconciliation, request-origin and
BrowserAuth rejection, remote permission-disabled and consented flows, live
permission revocation, full configuration admission, prototype/resource guards,
secret redaction, and independent local-only system operations.

Historical release and architecture notes describing a remote field allow-list
document the behavior **at the time of those releases**; this document describes
the updated behavior after the unified-settings change.
