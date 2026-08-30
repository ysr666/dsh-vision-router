# Remote Vision Router settings

Vision Router uses a dedicated DSH Connection RPC channel at `/vision-router-settings/*` because the global DSH settings/credentials plane is intentionally loopback-only.

Remote editing is off by default. When a Vision Router settings page is opened through a DSH trusted host while the permission is still disabled, the page shows an explicit risk confirmation. Cancelling leaves remote editing disabled and writes nothing. Confirming enables only `allowRemoteSettings`, then reloads the scoped Vision Router settings immediately. The same permission can still be enabled or revoked from the loopback settings page.

DSH `trustedHosts` protects the browser carrier against Host/Origin/DNS-rebinding attacks; it is **not user authentication**. Enable remote editing only when you trust the clients that can reach the DSH instance. Ordinary remote mutations remain restricted to the explicit Vision Router allow-list. Credential-bearing HTTP providers, local Ollama/LM Studio configuration, artifact paths and every other field not present in that allow-list stay unavailable remotely. `allowRemoteSettings` itself is not added to the ordinary mutation allow-list: it can be enabled only through the explicit risk-confirmation flow (or from the loopback settings page).

If DSH is behind Nginx, Caddy or another reverse proxy, forward `/vision-router-settings/*` to the same DSH origin in addition to the normal DSH routes. The UI detects a 404 on this channel and shows this requirement directly.
