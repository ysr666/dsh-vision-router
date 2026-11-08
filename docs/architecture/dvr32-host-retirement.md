# DVR 3.2 Host retirement and rollback

**Branch:** feat/dvr32-retire-legacy-host. **Not merged, not released.** Scope: DSH >=0.2.1-rc.5 <0.3.0-0; Node >=24.9.0.

1. Retire the private web-connection-ready plugin and all Connection config/trustedHosts overrides. Retain precisely one Connection inject: [webStartup, webServer] patch because the native Connection provider's generic foreign RPC registrations otherwise return HTTP 405 in Windows multi-plugin tests. Do not change official Host authentication or add trusted authorities.
2. Preserve modules/webServer ordering, the DVR disabled:false recompose guard and old user-data migrators until separately proven obsolete.
3. Keep engines.dsh as the **supported** Host compatibility authority. Retire the conflicting anonymous-user-id and storage-domain optional peers, but retain **one optional dsh-llm-deepseek peer** to reject older DSH 0.2.0 Hosts that ignore engines.dsh. Update engines.node, development fixtures, Doctor and release notes together.
4. Negative admission must reject DSH 0.1.x, DSH 0.2.0, DSH 0.2.1-rc.4, Node 22 and Node 24.8.
5. Require real DSH 0.2.1-rc.5 and 0.2.2-rc.1 installs: cold start, three enable-disable-reenable cycles, reconnection, 303/401/200, authenticated/unauthenticated API, WebSocket, trusted/untrusted LAN, actual Vision image turn and Settings/restart readback.
6. Windows, macOS and Linux exact-source gates plus build, typecheck, reproducible pack and migration tests must be green.
7. Retired Host workflows become historical/manual checks, not mandatory 3.2 release gates. Preserve old 3.1.4 packages and the historical support document.

**Rollback:** Revert the isolated 3.2 branch. Never auto-rewrite the user's profile patches, delete sessions, or release a partial change. Review manual profile-owned Connection overlays separately before user migration.

## CI security pre-release hardening

The 3.2 DSH rc5 fixture introduced an unsafe transitive zod@4.4.3 (GHSA-mrhx-c7xc-m3w5). The workspace forces zod@4.6.7 across development fixtures, including DSH's transitive packages; the release manifest also consumes the patched runtime version. Recheck the entire lockfile and GitHub dependency review before publishing.

The floating DSH Alpha surveillance lane checks out an upstream commit chosen from a separately reviewed pin and runs on schedule or dispatch. It must never restore or save a shared Actions build cache that a later trusted branch could consume. All three Alpha Host job families now build in disposable job state; this costs CI time intentionally. Do not put the cache back merely to optimize the Alpha lane.

The weekly/dispatch Alpha settings workflow uses a literal reviewed immutable
SHA in all three upstream checkouts, and checks the config pin against that SHA
before fetching any upstream code. A config-only pin refresh bot cannot change
workflow execution authority; the human reviewer must explicitly update all
three static refs to the newly approved commit. A stale pin fails closed.

## Windows multi-plugin 405 counterexample (2026-11-08)

Original zero-Connection-overlay release candidate passed normal DVR image-tool E2E but **failed** the independent third-party RPC/HTTP waterfall six-order test. With official DSH 0.2.2-rc.1, POST /fixture-rpc/ping fell through to the resource handler (405), because generic connection.rpc.handle registers its route using the Connection provider Fiber's webServer capability, which the DSH native Connection row did not inject. A minimal Connection overlay declaring inject: [webStartup, webServer] preserves the official config.trustedHosts unchanged and returned 200 for all six plugin orderings. This is a non-retired activation boundary, not authorization ownership. Security regression tests reject any extra Connection keys, a missing webServer, or revived private readiness service. Both supported exact-source DSH gates must assert the composed Connection retains the official config in structured form.

## Retired DSH alpha.4 browser forensic

The previous continuous PR browser smoke explicitly checked out DSH 0.1.2-alpha.4,
which predates the DVR 3.2 minimum by several years and still requires the
legacy webRuntime Connection dependency. Keeping it as a PR release gate would
force the private readiness bridge back into production, negating this retirement.
The original #387 forensic workflow is retained as workflow_dispatch only,
using the last green historical DVR fbe230ca04c2... and the original
pre-#388 comparison c7c92d25f7c5..., so investigators can still reproduce the
old bug without pretending that DVR 3.2 supports the retired Host.
The **same alpha-browser-cold-toggle-smoke.mjs** remains an active PR/main gate
against supported pinned DSH 0.2.1-rc.5 in dsh-021-rc5-validation.yml;
that live cold toggle, Settings lifecycle, and renderer tests must not be removed.

## Upgrade preflight and safe rollback for existing profiles

This is a **prerelease** compatibility change, not an automatic 3.1.x patch.
The 3.1.4 line remains available. **Do not update a working DSH profile merely
to validate this PR.** Validate first in a disposable profile / development
installation; do not test by rewriting someone else's live config.

1. Verify Node.js >=24.9.0 and the actual DSH executable's version is within
   `>=0.2.1-rc.5 <0.3.0-0`. Check the **running Desktop's bundled Host**
   separately from a shell's unrelated `dsh` command. An Oh-DSH profile has
   its own home and must not be confused with the official ~/.dsh home.
2. Back up the **complete selected profile directory**, including
   `package.json`, `pnpm-lock.yaml`, and `cordis.patch.yml`, and record the
   previous DSH and DVR package versions. Keep independent session, attachment,
   and settings data intact; do not auto-delete or auto-migrate those stores.
3. From the **3.2 source checkout**, run the **read-only** preflight:
   `node lib/doctor-cli-p0.js doctor --profile desktop --upgrade-preflight --no-runtime`
   (or substitute `web` for the actual profile). Never use `--fix` or `repair`
   as a preflight, and do not paste raw private reports into public issues.
   The explicit `--upgrade-preflight` mode returns **nonzero** for known
   profile-owned Connection overrides, retired ready-bridge references, stale
   workspace version-pinned release-age exclusions, floating GitHub DVR
   package refs (default branch, main/master or other non-immutable branches),
   or an unsupported Node version. Ordinary `doctor` still treats historical
   patch warnings as advisories. A zero exit means only that these known **local profile**
   hazards were not detected: it never proves the actual Desktop Host version,
   runtime image-tool functionality, browser trust, or session migration.
   Report `upgradePreflight.fullReleaseApproval` is always false.
   In particular, a `github:ysr666/dsh-vision-router` or `#main` dependency
   may update as soon as `main` advances, bypassing npm `next` altogether.
   A locked `pnpm-lock.yaml` records today's commit but is not a permanent
   safeguard against future lock regeneration. Explicit version tags are
   more stable than branches but can still be force-moved; only a full commit
   SHA is immutable. These version-specific refs are exempt from this
   floating-source warning. Freeze refs only in a **backed-up isolated profile copy**
   first; do not silently rewrite active development profiles.
4. If Doctor finds a **profile-owned** `id: connection` row or any
   `visionRouterWebConnectionReady` / `vision-router-web-connection-ready`
   reference, review the user's exact custom overlay **after backup** before
   enabling 3.2. Profile patches apply after bundled patches: a historic
   `webRuntime` injection or old Connection `config` can override the newly
   verified Host settings and break startup. **Never delete arbitrary profile
   rows, credentials, trusted hosts, or another plugin's configuration.**
5. The 3.2 **bundle-owned** Connection row is intentional and should not be
   removed: its only override is `inject: [webStartup, webServer]`, preserving
   the official Host's `config.trustedHosts` and auth semantics. Doctor's
   **profile-owned** override warnings refer to *separate, later user patches*,
   not to this bundled compatibility ordering shim.
6. On a disposable upgraded profile, verify cold start, Settings save/reload,
   browser auth, actual vision result, third-party plugin RPC, and disabling
   the **entire** DVR bundle without losing the Host's `/`, `/connect`, or
   `/api` routes. Restore the backed-up profile together with the previously
   installed compatible DSH/DVR pair if recovery is required. Never claim
   session or image preservation from a fresh-profile-only test.

### Historical DSH session format is a separate upstream upgrade gate

An installer-compatible Host does **not** prove historical Session migration.
The released DSH v0 format writer once produced `permission/preset` with an
additional `origin` key, which current v0-to-v1 readers may reject. Older
Hosts also reject certain released `subagent/descriptor` version-2 events.
See upstream [discussion #9421](https://github.com/deepseek-ai/deepseek-harness/discussions/9421)
and [#9343](https://github.com/deepseek-ai/deepseek-harness/discussions/9343).
These are **DSH persistence-reader responsibilities**, not DVR vision routing.

Before retiring a user's old Host, validate **their data** using an isolated
backup and the target Host's actual Session-persistence `open(id, 'read')`
API. For legacy v0 stores, favor 0.2.2-rc.1 over 0.2.1-rc.5 where version-2
subagent descriptors exist; even 0.2.2-rc.1 cannot read all original
`permission/preset.origin` sources unmodified. A narrow offline
normalization of known released variants can be evaluated **only on a copy**,
with original byte-identical backups and read-only API verification. Do not
strip arbitrary event fields, migrate all user logs in-place, or infer
successful history migration from the plugin's profile preflight status.
No historical-log repair or automatic migration is implemented in DVR 3.2.

No code in this PR edits existing user profiles, session logs, image attachments,
or saved settings as part of retirement. The remaining upstream stale-Fiber HMR
issue and the separate #792 source-text screenshot investigation stay tracked
independently; this document does not claim that either upstream defect is fixed.


## DSH 3.2 legacy admission and peer-graph retirement: two-sided A/B

Supported DSH 0.2.1-rc.5+ uses `engines.dsh` as its sole native
plugin-admission authority, but **official DSH 0.2.0-rc.2 only inspects
`@deepseek-ai/dsh-*` peers**, ignoring `engines.dsh` entirely. Testing
that official old evaluator against an otherwise identical 3.2 manifest
proved the crucial negative control:
- **Zero DSH peer declarations**: old DSH 0.2.0-rc.2 **incorrectly admits**
  DVR 3.2. This is unsafe, even though 3.2 announces that it retired 0.2.0.
- One optional `@deepseek-ai/dsh-llm-deepseek` peer with the exact canonical
  `>=0.2.1-rc.5 <0.3.0-0` requirement: old DSH 0.2.0-rc.2 **rejects**
  DVR 3.2. Modern rc5/rc1 evaluators still use `engines.dsh` first.

Therefore DVR 3.2 **retains exactly one** optional DSH LLM peer solely to
protect legacy Hosts that have not yet learned `engines.dsh`. It retires the
other two old optional DSH peers (`anonymous-user-id` and `storage-domain`)
because they add pnpm dependency-graph conflicts without protecting the
minimum supported Host any further. The `sharp` optional peer is unaffected.

Disposable Node 24.21 / pnpm 11.20 strict-install A/B using the actual
3.2 prerelease tarball and published Host provider components:
- With DSH llm-deepseek rc1 alone, the original three-peer candidate **failed**
  `ERR_PNPM_PEER_DEP_ISSUES` because anonymous-user-id had two constraints
  but was not explicitly installed.
- Installing anonymous-user-id explicitly made that original candidate pass,
  confirming the cause was the peer graph, not RC version admission.
- Retaining only the **single legacy LLM guard** and `sharp` passed
  `strictPeerDependencies=true` with DSH llm-deepseek **both rc5 and rc1**,
  without an explicit anonymous-user-id install.
- A package with zero legacy peers also installed, but failed the older-Host
  safety requirement above, and was intentionally discarded.

DSH Host modules must still not be imported statically at runtime by
DVR's activation entries; the source, generated-tree and
child-process negative-control tests continue blocking all three
Host-provided module names (even the two no longer in peerDependencies).
The source-only storage-domain import is type-only.

No real user profile or npm release was changed during these tests.

## Release-channel safety when retiring old Host generations

Retirement is a new minor prerelease, **not a default npm upgrade**.
The protected release workflow must verify on Node >=24.9 (exact Node 24.21
in the release verification job). Before creating an immutable Git tag,
`scripts/release-channel.mjs` classifies only canonical stable, `rc.N`,
and `alpha.N` versions; unknown preview classes fail closed.

- `3.2.0-rc.0` publishes to npm `next` and is marked GitHub prerelease,
  never GitHub Latest; `3.2.0-alpha.N` would use npm `alpha`.
- Only a reviewed stable version such as `3.2.0` may update npm `latest`
  and GitHub Latest. The existing DVR 3.1.4 package stays installable.
- This release-channel gate is independent from the installation,
  profile-upgrade and real image-tool acceptance gates. Success here
  does not authorize publishing, re-tagging an immutable npm version,
  or rewriting any user profile.
