# Native OCR release staging (development only)

This is an isolated maintainer entry point; the installed plugin, npm package,
production worker digests and download catalog are unchanged. No publication
or license clearance follows from staging.

## Exact new worker identities

- Windows x64: `d1d958de7d48474aac1b945cfa4d8f0a70c05745334322d00f776c17c70b7166`.
  Clean Apple Silicon CI reproduced the historical stock digest and the
  remediated Windows-native digest exactly in
  [44244890944/job/134643857924](https://github.com/ysr666/dsh-vision-router/actions/runs/44244890944/job/134643857924).
  CRT reconstruction reproduced 68 stripped objects with zero timestamps.
  The private earlier Windows-native acceptance used this same worker digest,
  but its archive is not necessarily the new staging archive.
- Mac ARM64: `56499298089bc98709d3b6818fc870c8cf16c4c8607edd5ded842f304cbe84de`.
  Clean CI independently built both copies and exercised the worker in
  [44244890944/job/134643926507](https://github.com/ysr666/dsh-vision-router/actions/runs/44244890944/job/134643926507).
  Targets macOS 13.0; actual minimum-OS execution remains unverified. This
  digest differs from the private earlier archive and requires fresh acceptance.

Staging requires all five Windows-canonical model files, including the two
exact param files. Mac pnnx output is an audit-only alternate and is refused.
Do not transport private binaries, model files or archives in public CI artifacts.

## Local staging

Use Node 24.9+ in a reviewed source checkout. Supply exact independently
built worker and exact canonical models in private directories. Output must
be a new directory whose parent exists. Cross-host staging does not execute
the worker. Example:

```sh
node quality/native-ocr-release-stage.mjs --stage --target win32-x64 \
  --binary /private/lab/worker.exe --models /private/lab/models \
  --out /private/lab/release-stage-win
```

The private output is the exact tar.gz plus an evidence JSON with per-file
manifest, hash, byte size, SBOM hash and deterministic archive replay. It is
NOT an installable production release: production runtime pins and approved
download catalog still reject the new worker/archive. The staging command
verifies canonical source notices and keeps the SBOM incomplete /
distributionReady false. Public CI uploads evidence JSON only, never the
worker, model parameters or installable archive.

## Completed acceptance (2026-11-19; still not a release)

Clean audit run [#44451773187](https://github.com/ysr666/dsh-vision-router/actions/runs/44451773187)
built and staged the **actual exact deterministic archives** separately on
both native systems, with genuine installer, tamper rejection and OCR.
The same files passed actual Electron Settings and Agent tool execution under
DSH 0.2.2-rc.5, using isolated test-only HTTPS injection:

- **Mac ARM64:** worker `56499298089bc98709d3b6818fc870c8cf16c4c8607edd5ded842f304cbe84de`,
  archive `a5245c2420fa10ab9da124e2f8e308930a202c6239b4711b0dd73c14f29b78cd`,
  Agent ncnn OCR `TEST 123`, no vision model fallback.
- **Windows x64:** worker `d1d958de7d48474aac1b945cfa4d8f0a70c05745334322d00f776c17c70b7166`,
  archive `fd5791ed9697dbd32ac59b1025600a8a299d8884c607acf6f977445310734ae0`,
  Agent ncnn OCR `HELLO 123`, no vision model fallback. The installer no
  longer needs an external system `tar` executable.
- Final proof and evidence-only artifact digests:
  `quality/native-ocr-current-host-desktop-evidence.json`.

### macOS compatibility boundary (static evidence, not an OS runtime pass)

The native ARM64 Worker has Mach-O `LC_BUILD_VERSION minos 13.0` and the
tested DSH Desktop uses Electron 44 (whose upstream platform policy covers
macOS 13+). This is **not** proof that the *entire* installed stack executes
on macOS 13.0. In particular, the official **standalone Node.js 24 binaries**
require macOS **13.5+**; a CLI/system-Node installation may therefore have a
different floor than a Desktop that embeds its own Electron Node runtime.
See [Node v22-to-v24 migration](https://nodejs.org/en/blog/migrations/v22-to-v24)
and [Electron 44 platform policy](https://www.electronjs.org/blog/electron-44-0).
Test real minimum OS configurations before advertising 13.0 or changing the
supported floor; no production minimum was changed here.

**Remaining independent release gates:** complete *transitive compiler-header*
and retained-code licensing/attribution review, actual lowest-supported OS
runtime tests (the Mac Mach-O declares minos 13.0 but this is static),
authorized publication of the archives followed by a genuinely public HTTPS
download test, owner review and separate explicit approvals for PR merge,
production catalog/hash promotion, formal version changes, npm or GitHub
release. No public binary/model archive or production allowlist was created.

## npm resource delivery (development only)

The optional download path targets exact, versioned npm Registry tarballs for
`dsh-vision-router-ocr-darwin-arm64` and `dsh-vision-router-ocr-win32-x64`.
The initial staging builder now also emits a deterministic `0.0.0-staging`
resource package containing the unchanged native archive; it records both
outer and inner SHA-256 and byte counts in staging-evidence.json. Runtime
verifies both layers in memory and executes no npm lifecycle scripts. The
Desktop and CLI staging tests inject the npm tarball, not a GitHub asset.
To prepare a separately authorized resource-package version from the same
canonical native archive, run:

```sh
node quality/native-ocr-npm-package.mjs --stage PRIVATE_STAGE_DIR --version RESOURCE_VERSION --out NEW_PRIVATE_DIR
```

This creates a standard npm-format `.tgz` and evidence only, with no network
publish and no production pin changes. The package names are proposed until
registry ownership/Trusted Publishing is confirmed. Do not publish the staging
version; the formal two-package resource promotion and main-plugin release
remain independently authorized. Public CI must upload only evidence JSON.
