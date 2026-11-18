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
NOT an installable production release: runtime pins still reject the new
worker. The staging command verifies canonical source notices and keeps the
SBOM incomplete/distributionReady false. CI verifies real worker and model
inputs separately, uploads evidence only under the existing workflow policy,
and does not claim to have assembled the final package when those artifacts
are not co-located.

Next gates: stage actual archives privately; test the exact archives through
the real Desktop installer and OCR on each supported target; minimum OS
runtime; verify the final link/source/notice/SBOM inventory and provenance;
owner review; explicit approval before hosting, pin/catalog promotion and
any npm or GitHub publication. No private-lab archive is silently promoted.
