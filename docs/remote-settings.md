# Remote Vision Router settings

Vision Router uses a dedicated DSH Connection RPC channel at `/vision-router-settings/*` because the global DSH settings/credentials plane is intentionally loopback-only.

Remote editing is off by default. Enable it only from the loopback Vision Router settings page. DSH `trustedHosts` protects the browser carrier against Host/Origin/DNS-rebinding attacks; it is **not user authentication**. Vision Router therefore exposes only an explicit allow-list of low-risk preferences remotely. Network/proxy settings, credential-bearing HTTP providers, local Ollama/LM Studio endpoints, artifact paths, desktop capture, stealth/route ownership and the remote permission itself remain loopback-only.

If DSH is behind Nginx, Caddy or another reverse proxy, forward `/vision-router-settings/*` to the same DSH origin in addition to the normal DSH routes. The UI detects a 404 on this channel and shows this requirement directly.
