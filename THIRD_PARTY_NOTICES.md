# Third-Party Notices

dsh-vision-router is distributed under the MIT license; it is not a relicensing of its dependencies.
The versioned VTracer WASM package is distributed separately as an npm dependency.
This document records the vectorizer-related notices and a reviewed license snapshot.

## Runtime direct dependencies

| Package | License |
| --- | --- |
| `@deepseek-ai/schemastery` | MIT |
| `@visioncortex/vtracer` | MIT OR Apache-2.0 (MIT selected) |
| `puppeteer-core` | Apache-2.0 |
| `semver` | ISC |
| `undici` | MIT |
| `zod` | MIT |

## VTracer and compiled Rust components

- NPM package: `@visioncortex/vtracer@1.0.0-alpha.4`.
- Corresponding source tag: https://github.com/visioncortex/vtracer/tree/1.0.0-alpha.4
- Source commit: `2500df76b5aea0ac22d15296b22722442f825c5b`.
- License choice: MIT (the upstream package declares MIT OR Apache-2.0).
- Full MIT license including upstream copyright: `assets/licenses/vtracer-MIT.txt`.
- Apache-2.0, BSD-2-Clause, BSD-3-Clause, Zlib and Unicode-3.0 notice/license texts: `assets/licenses/`.
- unicode-ident additionally requires Unicode-3.0; its exact text is included.
- The Rust package inventory below was resolved from the exact source tag on 2026-11-11.
  It is NOT proof of original prebuilt npm WASM dependency revisions; see
  `docs/compliance/vtracer-alpha4-provenance.md`.

| Rust crate | Resolved version | Declared SPDX license |
| --- | --- | --- |
| [`adler2`](https://crates.io/crates/adler2/2.0.1) | 2.0.1 | `0BSD OR MIT OR Apache-2.0` |
| [`aliasable`](https://crates.io/crates/aliasable/0.1.3) | 0.1.3 | `MIT` |
| [`autocfg`](https://crates.io/crates/autocfg/1.5.1) | 1.5.1 | `Apache-2.0 OR MIT` |
| [`bit-vec`](https://crates.io/crates/bit-vec/0.6.3) | 0.6.3 | `MIT/Apache-2.0` |
| [`bitflags`](https://crates.io/crates/bitflags/2.13.2) | 2.13.2 | `MIT OR Apache-2.0` |
| [`bumpalo`](https://crates.io/crates/bumpalo/3.20.3) | 3.20.3 | `MIT OR Apache-2.0` |
| [`bytemuck`](https://crates.io/crates/bytemuck/1.25.2) | 1.25.2 | `Zlib OR Apache-2.0 OR MIT` |
| [`byteorder-lite`](https://crates.io/crates/byteorder-lite/0.1.0) | 0.1.0 | `Unlicense OR MIT` |
| [`cfg-if`](https://crates.io/crates/cfg-if/1.0.5) | 1.0.5 | `MIT OR Apache-2.0` |
| [`color_quant`](https://crates.io/crates/color_quant/1.1.0) | 1.1.0 | `MIT` |
| [`crc32fast`](https://crates.io/crates/crc32fast/1.5.5) | 1.5.5 | `MIT OR Apache-2.0` |
| [`either`](https://crates.io/crates/either/1.19.0) | 1.19.0 | `MIT OR Apache-2.0` |
| [`fdeflate`](https://crates.io/crates/fdeflate/0.3.7) | 0.3.7 | `MIT OR Apache-2.0` |
| [`flate2`](https://crates.io/crates/flate2/1.1.11) | 1.1.11 | `MIT OR Apache-2.0` |
| [`flo_curves`](https://crates.io/crates/flo_curves/0.3.1) | 0.3.1 | `Apache-2.0` |
| [`flo_curves`](https://crates.io/crates/flo_curves/0.8.1) | 0.8.1 | `Apache-2.0` |
| [`futures-core`](https://crates.io/crates/futures-core/0.3.34) | 0.3.34 | `MIT OR Apache-2.0` |
| [`futures-task`](https://crates.io/crates/futures-task/0.3.34) | 0.3.34 | `MIT OR Apache-2.0` |
| [`futures-util`](https://crates.io/crates/futures-util/0.3.34) | 0.3.34 | `MIT OR Apache-2.0` |
| [`gif`](https://crates.io/crates/gif/0.14.2) | 0.14.2 | `MIT OR Apache-2.0` |
| [`heck`](https://crates.io/crates/heck/0.4.1) | 0.4.1 | `MIT OR Apache-2.0` |
| [`image`](https://crates.io/crates/image/0.25.10) | 0.25.10 | `MIT OR Apache-2.0` |
| [`image-webp`](https://crates.io/crates/image-webp/0.2.4) | 0.2.4 | `MIT OR Apache-2.0` |
| [`itertools`](https://crates.io/crates/itertools/0.14.0) | 0.14.0 | `MIT OR Apache-2.0` |
| [`itertools`](https://crates.io/crates/itertools/0.8.2) | 0.8.2 | `MIT/Apache-2.0` |
| [`js-sys`](https://crates.io/crates/js-sys/0.3.107) | 0.3.107 | `MIT OR Apache-2.0` |
| [`miniz_oxide`](https://crates.io/crates/miniz_oxide/0.8.9) | 0.8.9 | `MIT OR Zlib OR Apache-2.0` |
| [`miniz_oxide`](https://crates.io/crates/miniz_oxide/0.9.1) | 0.9.1 | `MIT OR Zlib OR Apache-2.0` |
| [`moxcms`](https://crates.io/crates/moxcms/0.8.1) | 0.8.1 | `BSD-3-Clause OR Apache-2.0` |
| [`num-traits`](https://crates.io/crates/num-traits/0.2.19) | 0.2.19 | `MIT OR Apache-2.0` |
| [`ouroboros`](https://crates.io/crates/ouroboros/0.18.5) | 0.18.5 | `MIT OR Apache-2.0` |
| [`ouroboros_macro`](https://crates.io/crates/ouroboros_macro/0.18.5) | 0.18.5 | `MIT OR Apache-2.0` |
| [`pin-project-lite`](https://crates.io/crates/pin-project-lite/0.2.17) | 0.2.17 | `Apache-2.0 OR MIT` |
| [`png`](https://crates.io/crates/png/0.18.1) | 0.18.1 | `MIT OR Apache-2.0` |
| [`proc-macro2`](https://crates.io/crates/proc-macro2/1.0.107) | 1.0.107 | `MIT OR Apache-2.0` |
| [`proc-macro2-diagnostics`](https://crates.io/crates/proc-macro2-diagnostics/0.10.1) | 0.10.1 | `MIT/Apache-2.0` |
| [`pxfm`](https://crates.io/crates/pxfm/0.1.30) | 0.1.30 | `BSD-3-Clause OR Apache-2.0` |
| [`quick-error`](https://crates.io/crates/quick-error/2.0.1) | 2.0.1 | `MIT/Apache-2.0` |
| [`quote`](https://crates.io/crates/quote/1.0.47) | 1.0.47 | `MIT OR Apache-2.0` |
| [`roots`](https://crates.io/crates/roots/0.0.6) | 0.0.6 | `BSD-2-Clause` |
| [`roots`](https://crates.io/crates/roots/0.0.8) | 0.0.8 | `BSD-2-Clause` |
| [`rustversion`](https://crates.io/crates/rustversion/1.0.23) | 1.0.23 | `MIT OR Apache-2.0` |
| [`serde`](https://crates.io/crates/serde/1.0.229) | 1.0.229 | `MIT OR Apache-2.0` |
| [`serde_core`](https://crates.io/crates/serde_core/1.0.229) | 1.0.229 | `MIT OR Apache-2.0` |
| [`serde_derive`](https://crates.io/crates/serde_derive/1.0.229) | 1.0.229 | `MIT OR Apache-2.0` |
| [`serde-wasm-bindgen`](https://crates.io/crates/serde-wasm-bindgen/0.6.5) | 0.6.5 | `MIT` |
| [`simd-adler32`](https://crates.io/crates/simd-adler32/0.3.10) | 0.3.10 | `MIT` |
| [`slab`](https://crates.io/crates/slab/0.4.12) | 0.4.12 | `MIT` |
| [`smallvec`](https://crates.io/crates/smallvec/1.16.5) | 1.16.5 | `MIT OR Apache-2.0` |
| [`static_assertions`](https://crates.io/crates/static_assertions/1.1.0) | 1.1.0 | `MIT OR Apache-2.0` |
| [`syn`](https://crates.io/crates/syn/2.0.119) | 2.0.119 | `MIT OR Apache-2.0` |
| [`syn`](https://crates.io/crates/syn/3.0.10) | 3.0.10 | `MIT OR Apache-2.0` |
| [`unicode-ident`](https://crates.io/crates/unicode-ident/1.0.27) | 1.0.27 | `(MIT OR Apache-2.0) AND Unicode-3.0` |
| [`version_check`](https://crates.io/crates/version_check/0.9.5) | 0.9.5 | `MIT/Apache-2.0` |
| [`visioncortex`](https://crates.io/crates/visioncortex/0.9.3) | 0.9.3 | `MIT OR Apache-2.0` |
| [`vtracer`](https://crates.io/crates/vtracer/1.0.0-alpha.4) | 1.0.0-alpha.4 | `MIT OR Apache-2.0` |
| [`vtracer-wasm`](https://crates.io/crates/vtracer-wasm/1.0.0-alpha.4) | 1.0.0-alpha.4 | `MIT OR Apache-2.0` |
| [`wasm-bindgen`](https://crates.io/crates/wasm-bindgen/0.2.130) | 0.2.130 | `MIT OR Apache-2.0` |
| [`wasm-bindgen-macro`](https://crates.io/crates/wasm-bindgen-macro/0.2.130) | 0.2.130 | `MIT OR Apache-2.0` |
| [`wasm-bindgen-macro-support`](https://crates.io/crates/wasm-bindgen-macro-support/0.2.130) | 0.2.130 | `MIT OR Apache-2.0` |
| [`wasm-bindgen-shared`](https://crates.io/crates/wasm-bindgen-shared/0.2.130) | 0.2.130 | `MIT OR Apache-2.0` |
| [`weezl`](https://crates.io/crates/weezl/0.1.12) | 0.1.12 | `MIT OR Apache-2.0` |
| [`yansi`](https://crates.io/crates/yansi/1.0.1) | 1.0.1 | `MIT OR Apache-2.0` |
| [`zlib-rs`](https://crates.io/crates/zlib-rs/0.6.8) | 0.6.8 | `Zlib` |
| [`zune-core`](https://crates.io/crates/zune-core/0.5.3) | 0.5.3 | `MIT OR Apache-2.0 OR Zlib` |
| [`zune-jpeg`](https://crates.io/crates/zune-jpeg/0.5.15) | 0.5.15 | `MIT OR Apache-2.0 OR Zlib` |

All crates in this independent resolution have a declared license; none declares GPL, LGPL, or AGPL.
This summary does not waive upstream attribution, notice or source obligations.

## Note on prior releases

Earlier DVR versions used `potrace@2.1.8`, which declares GPL-2.0.
This change removes it. Historical distribution legal obligations need separate review.
