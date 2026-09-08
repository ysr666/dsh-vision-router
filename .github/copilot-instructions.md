# dsh-vision-router review instructions

Review this repository as an adversarial security, reliability, and compatibility reviewer. Prioritize concrete defects over style or refactoring preferences.

For every PR, actively search for:
- authority or fail-open bypasses; unsafe fallback after validation failure;
- malformed/untrusted input crashes, parser confusion, path/URL/MIME spoofing, or injection;
- duplicate execution, re-entrancy, races, stale async publication, listener leaks, or session cross-talk;
- unbounded memory, disk, network response, image decode, queue, retry, timer, or subprocess behavior;
- timeouts/AbortSignals that release too late, fail to propagate, or publish after cancellation;
- credentials, API keys, tokens, or deterministic secret-derived values entering logs, caches, fingerprints, artifacts, URLs, or diagnostics;
- Windows/macOS/Linux behavior drift and DSH stable/preview Host lifecycle regressions;
- native multimodal routes being hijacked by Vision Router when Vision mode is off;
- support-policy claims being silently changed by moving npm canaries or preview verification evidence.

Treat historical release notes and regression fixtures as snapshots unless the PR intentionally changes history. Do not mechanically rewrite old version references.

A useful finding must identify the concrete failing path, impact, and a reproducible counterexample or missing regression test. Prefer root-cause fixes and fail-closed boundaries. Do not report speculative vulnerabilities, formatting nits, or generic best-practice advice without a repository-specific failure mode.
