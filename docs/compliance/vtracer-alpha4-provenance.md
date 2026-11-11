# VTracer 1.0.0-alpha.4: pinned artifact and compliance record

Verified 2026-11-11 on Windows Node 24.21.0 and macOS arm64 Node 24.5.0.

## Release coordinates

- npm package: @visioncortex/vtracer@1.0.0-alpha.4
- npm published timestamp: 2026-08-29T00:08:36.284Z
- npm gitHead and upstream tag 1.0.0-alpha.4 commit: 2500df76b5aea0ac22d15296b22722442f825c5b
- npm package integrity (sha512): Hhi+vfG4ealLH1m9alrWo1lM00cWFfur4zeLEcNtzrYUjeEYTgukLNfvOXmuaGe2adugu+jl9o9IUzqHuqFO9g==
- npm package unpacked: 8 files / 692673 bytes, includes pkg/vtracer_wasm_bg.wasm
- wasm file size: 668378 bytes
- wasm SHA-256: 63716b70497b7468ef97545b50f5f34b8bbb7acde2d7b00deb4eb40781446d45
- Windows and macOS installed WASM hashes match exactly.
- The source commit and release are aligned through npm gitHead, not by an independent byte-identical source reproduction.

## Rust dependency audit

- Source checkout pinned to the exact npm commit and tag, not the repository default branch.
- Node/WASM subproject: nodejs/Cargo.toml, platform wasm32-unknown-unknown.
- An independently resolved Cargo dependency graph contains 66 reachable normal/build nodes, all with SPDX license metadata and no declared GPL/LGPL/AGPL.
- Inventory: vtracer-alpha4-rust-inventory.json.
- Resolved lock: vtracer-alpha4-reconstructed-Cargo.lock.
- Explicit Unicode-3.0 conjunctive license: unicode-ident@1.0.27.
- The exact tagged source **does not track nodejs/Cargo.lock**. The included reconstructed lock is a reproducible *new resolution*, not an assertion about the versions used to produce the historical npm prebuilt WASM.

## Distribution notices and controls

- Upstream source tag has MIT text (root LICENSE). Original npm tarball has **no LICENSE/NOTICE**.
- DVR carries the upstream MIT text and additional relevant Rust license texts in assets/licenses/; THIRD_PARTY_NOTICES.md is in the npm package files list.
- pnpm license:check enforces the known npm integrity, installed WASM hash, no Potrace/Jimp closure, allowed SPDX license tokens and required notices.

## Independently rebuilt WASM (2026-11-11)

- On macOS Apple Silicon, Rust 1.97.1 successfully compiled the exact source tag for wasm32-unknown-unknown in release mode using the reconstructed pinned Cargo.lock.
- Raw compiler WASM SHA-256: 9812bfa008e7f54d59cd4e9823db44acfa1fbc1921e0b03f5494dfd5efd4840f.
- wasm-bindgen CLI 0.2.130 generated loadable Node bindings from the reconstructed Rust WASM.
- Rebuilt wasm-bindgen processed WASM SHA-256: aed7bba50a05cd773aa2d9a16f1d6521e695e4473b630ac2800a0c405da346ca.
- The rebuilt WASM exports vectorize_bytes and vectorize_rgba and can be loaded by Node.
- A 96x64 RGBA synthetic image passed an identical SVG output comparison between source-rebuilt and npm-distributed VTracer (matching SHA-256 prefix 6a68ed1e9946ce85).
- The rebuilt WASM is not byte-identical to the npm binary (different file sizes and hashes), so this is a source-build and functional-equivalence check, not historical reproducibility proof.

## Scope and remaining provenance limitation

The original npm-provided WASM cannot be claimed as reproducibly built from the historical Rust graph without the publisher's build receipt/toolchain/lock or a byte-identical rebuild. Pinning the package, source commit, integrity and WASM hash makes the exact redistributed artifact auditable, but does not eliminate that provenance limitation.

Before release: run the new package's true clean-install tests across Windows/macOS/Linux and verify supported official Host; test Dataelem's separate generation installer when accessible. Do not treat a normal npm/pnpm install as proof of that separate installer.
