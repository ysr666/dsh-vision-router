#!/usr/bin/env bash
# Rebuilds the permissive ncnn CPU OCR worker for Apple Silicon.
# This research builder does not download or publish model weights.
set -euo pipefail
umask 077
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || { echo "MAC_ARM64_REQUIRED" >&2; exit 65; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NCNN_SOURCE="${DVR_OCR_NCNN_SOURCE:-/tmp/dvr-ncnn-permissive-lIVHNT/ncnn}"
ROOT="${DVR_OCR_MAC_BUILD_ROOT:-/tmp/dvr-ocr-macos-bundle-lab-20261116}"
NCNN_BUILD="$ROOT/ncnn-build"
OUT="$ROOT/worker"
mkdir -p "$ROOT"
[[ "$(git -C "$NCNN_SOURCE" rev-parse HEAD)" == "d1f6ac67e9fc91390cc70f7168573fd2626f1d66" ]] || { echo "NCNN_SOURCE_REVISION_MISMATCH" >&2; exit 66; }
echo "6e3d7e41bd4599b7f5625cd103935d1cc015295ac50b4abcfaa3d3913d5b091d  $REPO/quality/native-ocr-lab.cpp" | shasum -a 256 -c -
cmake -S "$NCNN_SOURCE" -B "$NCNN_BUILD" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DNCNN_VULKAN=OFF -DNCNN_OPENMP=OFF \
  -DNCNN_SHARED_LIB=OFF -DNCNN_PIXEL=ON -DNCNN_BUILD_TOOLS=OFF \
  -DNCNN_BUILD_TESTS=OFF -DNCNN_BUILD_EXAMPLES=OFF \
  -DNCNN_BUILD_BENCHMARK=OFF > "$ROOT/cmake-private.log" 2>&1 || { tail -35 "$ROOT/cmake-private.log" >&2; exit 67; }
cmake --build "$NCNN_BUILD" --target ncnn -j 4 > "$ROOT/build-private.log" 2>&1 || { tail -35 "$ROOT/build-private.log" >&2; exit 68; }
/usr/bin/clang++ -O2 -std=c++17 \
  -I"$NCNN_SOURCE/src" -I"$NCNN_BUILD/src" "$REPO/quality/native-ocr-lab.cpp" \
  "$NCNN_BUILD/src/libncnn.a" -o "$OUT"
shasum -a 256 "$OUT" "$NCNN_BUILD/src/libncnn.a"
otool -L "$OUT"
echo "MAC_ARM64_SOURCE_BUILD_PASS"
