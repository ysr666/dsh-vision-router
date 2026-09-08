# Security Policy

## Supported versions

Security fixes are shipped on the current `2.1.x` release line. Users should run
the latest published patch release before reporting a suspected vulnerability.
Older release trains may be used as historical compatibility fixtures, but they
are not guaranteed to receive security backports.

DSH Host compatibility is a separate contract. See
`docs/architecture/dsh-support-window.md` for the current public Host support
floor and verification evidence; preview verification is not a security-support
promise.

## Reporting a vulnerability

Please use GitHub **Private Vulnerability Reporting** for security issues:

1. Open this repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected Vision Router/DSH versions, platform, reproduction steps,
   impact, and the smallest safe proof of concept you can provide.

Do **not** post exploit details, credentials, API keys, session data, or other
secrets in a public issue or Discussion.

## Scope and triage

Useful reports include authorization/fail-open bugs, cross-session data leaks,
credential or secret exposure, unsafe filesystem/network boundaries, resource or
availability attacks, and supply-chain/release-integrity problems.

Please distinguish a security vulnerability from ordinary compatibility or
reliability bugs where possible. If uncertain, report privately and the
maintainer will triage the boundary.

No response-time or bounty SLA is promised. Reports are prioritized by practical
impact, exploitability, and the number of affected users. When a fix is ready,
the project will prefer a regression test or other permanent gate that captures
the security boundary rather than a one-off patch.
