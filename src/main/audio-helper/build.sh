#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="$ROOT/src/main/audio-helper/AudioHelper.swift"
OUT_DIR="$ROOT/build/bin"
OUT="$OUT_DIR/audio-helper"

mkdir -p "$OUT_DIR"

xcrun swiftc \
  "$SRC" \
  -O \
  -target arm64-apple-macos13.0 \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -o "$OUT"

echo "built: $OUT"
