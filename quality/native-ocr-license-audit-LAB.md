# Native OCR distribution license closure — LAB (2026-11-15)

**Status: NOT cleared for redistribution.** This is an evidence inventory, not legal approval. The original private OCR photo, extracted strings, Host credentials, and full model weights must never enter source control.

## Identified components (source-backed)

| Item | Origin/version | License evidence | Audit status |
| --- | --- | --- | --- |
| Text detector | Official `PaddlePaddle/PP-OCRv6_small_det_onnx` (`inference.onnx`; source SHA-256 `d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e`) | [Official PaddlePaddle model card](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx) states Apache-2.0 | Official Hugging Face revision pinned: `28fe5895c24fd108c19eb3e8479f4ab385fbfc62`. Exact original ONNX bytes SHA-verified in the isolated Windows lab on 2026-11-15; **4/4 converted outputs reproduced with pinned pnnx 20261020 in isolated Windows lab; clean CI still open** |
| Text recognizer | Official `PaddlePaddle/PP-OCRv6_small_rec_onnx` (`inference.onnx`; source SHA-256 `5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634`) | [Official PaddlePaddle model card](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx) states Apache-2.0 | Official Hugging Face revision pinned: `b8f84f0b80c529de40b4fbb3544b84fa7233a513`. Exact original ONNX bytes SHA-verified in the isolated Windows lab on 2026-11-15; **4/4 converted outputs reproduced with pinned pnnx 20261020 in isolated Windows lab; clean CI still open** |
| Character dictionary | [`PaddleOCR/ppocr/utils/dict/ppocrv6_dict.txt`](https://github.com/PaddlePaddle/PaddleOCR/blob/main/ppocr/utils/dict/ppocrv6_dict.txt), local SHA-256 `b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d` | PaddleOCR repository Apache-2.0 context | **Upstream bytes verified:** `PaddleOCR@dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf`, 74,947 bytes / 18,708 lines, matches lab file byte-for-byte; model class-map derivation and redistribution notices remain open |
| ncnn C++ CPU runtime | `Tencent/ncnn@d1f6ac67e9fc91390cc70f7168573fd2626f1d66` | [Upstream LICENSE.txt](https://github.com/Tencent/ncnn/blob/master/LICENSE.txt): BSD-3-Clause; constituent notices additionally include zlib/BSD-2/BSD-3 | Config observed `OPENMP=OFF`, `VULKAN=OFF`, `SHARED_LIB=OFF`, tools/examples/tests OFF. Need source/build dependency inventory and redistributed notice text |
| Native wrapper | Lab's `quality/native-ocr-lab.cpp` plus Node supervisor and document logic | Project-maintained implementation | Review generated code/source attribution and final package terms |
| Windows CRT | MSVC x64 static `/MT` lab build | [Microsoft Visual Studio redistribution list](https://learn.microsoft.com/visualstudio/releases/2022/redistribution) | **Unclosed:** verify exact Visual Studio license and static runtime component redistribution obligations, or change build strategy |
| Linux x64-musl GCC prototype | Alpine 3.22.2 / WSL2, ELF x86_64, static ncnn archive | Installed package metadata: musl 1.2.5 **MIT**, libstdc++ / libgcc 14.2 **GPL-2.0-or-later AND LGPL-2.1-or-later** | Actual JPEG CPU inference/concurrent/cancel tests passed; **external libs are dynamically linked**. GCC runtime-exception obligations and possible LLVM libc++ alternative not yet closed; no permissive-only redistribution claim |
| macOS system dependencies | Actual ARM64 experimental executable, `otool -L` shows `/usr/lib/libc++.1.dylib`, `/usr/lib/libSystem.B.dylib` | macOS system-provided libraries | This is *one binary's* runtime closure, not Windows/Linux evidence |

## Frozen traceability (additional evidence, not release attestation)

The offline-checkable machine-readable lab inventory is `quality/native-ocr-provenance-LAB.json`, validated by `tests/native-ocr-provenance.test.js` against the **actual Node integrity gates**. It pins both official model repository revisions, detector/recognizer source SHA-256, ncnn source commit and build flags, official dictionary commit and its byte-for-byte match, all five converted output hashes, and the currently validated Mac ARM64/Windows x64 experimental executable hashes. It records both original ONNX files as freshly SHA-verified, four Windows laboratory **pnnx 20261020** converted outputs as byte-identical, and a Linux x64/musl native runtime pass. **Clean CI build reproducibility**, Linux glibc/ARM64/DSH Host, dependency notices, CRT review, SBOM and signatures remain unverified.

Source links are immutable revisions rather than `main` pointers. Upstream model metadata and PaddleOCR repository LICENSE state Apache-2.0; ncnn upstream LICENSE includes BSD-3-Clause and additional third-party license terms. These are origin claims; they are not a declaration that the final release payload meets every redistribution obligation.

## Linux Ubuntu22 static LLVM14 runtime closure (2026-11-16)

New Ubuntu22 Clang14/native OCR candidate **`f846ee63c87f73d7e704ff204b49f298b6241dd78053792734c4798bde4c8da0`** statically incorporates ncnn plus `libc++.a`, `libc++abi.a`, `libunwind.a`. Real `readelf -d` shows the *only* direct `NEEDED` entries are `libm.so.6` and `libc.so.6`; real `ldd` on Ubuntu22 shows these are also the only runtime libraries (plus dynamic loader), with no libgcc_s or libstdc++ even transitively. Highest imported GLIBC is 2.34. Real native and DSH Host tests passed on Ubuntu22 and original ELF was executed unchanged on Ubuntu24. The documented `llvm-static` build mode reproduced the same candidate byte-for-byte, using pre-staged source/models and pinned static archives. This **closes the *tested binary's* dynamically-linked GCC/C++ runtime dependency**, not all platform compatibility or legal distribution questions.

Exact Ubuntu `dpkg -S` sources and static archive SHA256:

| Embedded runtime | Ubuntu package `1:14.0.0-1ubuntu1.1` | SHA256 |
| --- | --- | --- |
| libc++ | `libc++-14-dev:amd64` | `ebd5c9b9fb457601ddc583a090866a9960dbf5b2f5e7cb527f05492874c343b4` |
| libc++abi | `libc++abi-14-dev:amd64` | `a4c5038f1f2fbefd032ea6411e4a19b4999b806a93e475aa1e4e22c137a363bf` |
| LLVM libunwind | `libunwind-14-dev:amd64` | `33fb4fdea2b1a84985531a9dc9f4eb5b731b04feb9354cb7ca787e2d6693fd46` |

The three installed `/usr/share/doc/<package>/copyright` texts identify `APACHE-2-LLVM-EXCEPTIONS`, including LLVM exceptions to Apache-2.0 §4(a), (b), (d) for embedded object code. The relevant compiler is Ubuntu `clang-14` `1:14.0.0-1ubuntu1.1`; `-rtlib=compiler-rt -unwindlib=none -nostdlib++` and a static link group were explicitly used. The corresponding runtime notices and the final output artifact still require packaging verification: a source package copyright record is evidence of terms, **not itself an installed NOTICE/SBOM**. The `llvm-static` build script hashes each of these three archives before linking and its strict ELF gate refuses any new direct non-`libc`/`libm` dynamic dependencies. This avoids treating the earlier Ubuntu22 dynamically linked LLVM variant (which inherited `libgcc_s` from distro `libc++abi.so.1`) as compliant.

## Release-specific unclosed work

1. **Promote lab reproduction to clean CI:** the source model SHA-256, pnnx 20261020 executable SHA-256, two shape pairs, `fp16=0`, `optlevel=2` and all 4 expected output hashes are now frozen in `quality/native-ocr-provenance-LAB.json`, with an exact-match PowerShell lab script. Repeat using a clean documented build runner and pin/verify its converter acquisition and licenses. Current byte identity is laboratory evidence, not a signed release attestation.
2. Collect upstream license files, model-card revision snapshots, ncnn third-party notices and necessary Apache-2.0 `LICENSE`/`NOTICE` attribution into the actual distributable release/npm artifact; verify no test-only font/image or license-incompatible transitive component is bundled.
3. Build `darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64-gnu`, and explicitly scoped Linux ARM64/musl outputs as applicable, each with `file`/`otool`/`ldd`/runtime import audits, hashes and a per-target SBOM.
4. Decide model storage, verified atomic installer, cleanup, upgrade and offline behavior before any default switch. Record native executable and model identities in the final package manifest and CI release attestation.
5. A passing existing `license:check` (`npm_packages=29`, Rust resolved nodes=66) checks current package dependencies only. **It does not close these new model/native redistribution requirements.**

**Mac ARM64 owner-installed bundle status (2026-11-16):** The patched worker built from pinned ncnn source using `quality/native-ocr-macos-build-LAB.sh` was independently linked twice with byte-identical SHA-256 `71d535b86b0543e7408b41ed66f45d3bea46e09e0e3f38aa491a32a60085d204`. A clean CMake rebuild of ncnn produced the same worker SHA. Its observed Mach-O runtime dependencies are only the macOS-shipped libc++ and libSystem. `scripts/package-native-ocr.mjs` created a 28 MB offline single-file archive from the verified worker, five model files and exact license texts; `scripts/install-native-ocr.mjs --bundle` installed and reverified it on the authorized Mac. The npm package does not bundle native models or binaries; the permissive-only source and packaged-license gate is exercised by `pnpm license:check`. This is *not* a legal opinion or all-platform release clearance.

**Windows x64 LLVM/UCRT research bundle (2026-11-16):** Superseding the old MSVC \`/MT\` lab candidate, the tested worker
\`2e4b96a204c34eebe11f117049b1a3b966f43a8402a66065c28773528cd18a33\`
was compiled by official pinned LLVM-MinGW 20261020 / Clang 23.1.4,
with ncnn pinned source and \`-static\`. Its PE import table has *only*
KERNEL32 and UCRT OS DLLs, no libc++/libunwind/GNU/MSVC C++ runtime DLL.
The static LLVM runtime license is **Apache-2.0 with LLVM Exceptions**;
MinGW-w64 runtime attribution is predominantly **ZPL/BSD/ISC/MIT/public domain**.
Its full original 12,155-byte COPYING notice is bundled, including disclosure
about LGPL Wine headers generally. The actual ncnn dependency graph exposed
743 unique toolchain headers. Initially the tree included the legacy
GPL-with-GCC-only-exception \`include/stdarg.h\`; this was replaced *in an
isolated extracted toolchain* with upstream LLVM's Apache \`lib/clang/23/include/stdarg.h\`
(verified SHA \`ce6e43d79dc89b50208ecf259b1ffd519f5a78cd3a2c7fcaac6386f376b89fef\`).
A **forced rebuild of 549 affected ncnn targets** followed. A fresh dependency
scan found zero GPL/LGPL-labeled headers; the single Wine-origin file was
\`corecrt_stdio_config.h\`, explicitly **Public Domain**. The new native worker
passed real 1,686-char / 56-region chemistry JPEG OCR, parallel workers,
malformed/blank input, recovery, and installed-without-canary \`vision_ocr(auto)\`
in an isolated Windows profile. A 35.3 MB single-file tar.gz bundle was
generated and atomically installed into a private Windows home; malformed and
tampered archive tests passed. Exact source tree and toolchain hashes, worker
hash, header before/after hashes and observed dependency scan are recorded in
\`quality/native-ocr-provenance-LAB.json\`. This is substantial **source-level
license evidence** for the tested binary, not an assertion about unrelated
toolchain contents or formal legal clearance.

**Remaining public-release gates: OPEN.** Clean signed CI build and attestation,
external release asset hosting, final exact-bundle notice review, Linux
platform scope and original #836 user-image acceptance remain unverified.
No change to \`main\`, no public binary release, no private fixture distribution. No change to `main`, no public binary release, no private fixture distribution.

### LLVM/libc++ Linux x64 alternative (experimental; not approved for redistribution)

A Clang 20.1.8 + LLVM libc++ worker built and passed actual CPU OCR, malformed inputs, two-worker concurrency, SIGTERM and subsequent recovery. Its `ldd` closure uses **libc++, libc++abi, LLVM libunwind and musl**, no GCC `libstdc++` or `libgcc_s`. Alpine metadata labels libc++/llvm-libunwind Apache-2.0 and musl MIT. Verify the full bundled library licenses, binary redistribution and NOTICE/SBOM before using these labels as release authorization. See `quality/native-ocr-linux-musl-LAB-20261115.md`.