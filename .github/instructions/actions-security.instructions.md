---
applyTo: ".github/workflows/**/*.yml,.github/workflows/**/*.yaml,.github/actions/**/*"
---

Treat workflow changes as supply-chain/security changes.

- Pin every third-party action to an immutable full commit SHA; comments may name the human-readable version.
- Keep `permissions` minimal and explicit. Do not expose write tokens, secrets, OIDC, or release credentials to untrusted pull-request code.
- Avoid shell interpolation of untrusted PR metadata. Prefer environment variables or structured arguments.
- Do not dynamically checkout mutable third-party refs as executable code.
- Keep release tags and npm artifacts bound to an exact verified `origin/main` SHA.
- Cache keys and artifacts must not let an untrusted job poison a privileged later job.
- Scheduled canaries may detect moving upstream releases but must not redefine public support policy.

A workflow review finding should name the privilege or trust-boundary transition that is exploitable or can regress.
