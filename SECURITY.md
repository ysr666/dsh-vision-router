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

## Repository integrity controls

The default `main` branch is protected against force pushes and deletion. Required
status checks run in strict mode, and repository administrators are subject to the
same protection instead of bypassing it. The current minimum merge gates are the
Node 22 test, Node 24 test, and current DSH contract check.

Human approval is not currently a mandatory merge gate. The repository has one
primary maintainer, so requiring an external approval would make maintainer PRs
unmergeable when no second maintainer is available. Automated/AI review is useful
additional evidence, but is not represented as human approval. This policy should
be revisited when a second active maintainer can reliably review changes.

Security-sensitive input boundaries also have deterministic adversarial fuzzing.
Pull requests replay a fixed seed for regression stability; scheduled and manual
runs add a rotating seed for broader exploration. A failing run reports the seed
and replay command so the exact corpus can be reproduced locally.

## Reporting a vulnerability

Please use [GitHub **Private Vulnerability Reporting**](https://github.com/ysr666/dsh-vision-router/security)
for security issues. Private vulnerability reporting is enabled for this repository.

1. Open the linked **Security** page.
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
