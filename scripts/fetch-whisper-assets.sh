#!/usr/bin/env bash
# Fetch whisper.cpp + silero-vad assets into build/.
# - whisper-cli: built from source at the pinned tag
# - ggml-large-v3-turbo.bin: downloaded from huggingface (multilingual, ~1.6 GB)
# - silero-vad.onnx: downloaded from snakers4/silero-vad (~2.3 MB)
#
# Idempotent: skips work if files already exist and are non-empty.
# Set FORCE=1 to redo everything.
# Override the model with WHISPER_MODEL_NAME=ggml-large-v3.bin (or any other
# whisper.cpp model name). The same name must also be passed to the app at
# runtime via WHISPER_MODEL (see src/main/whisper.ts).

set -euo pipefail

WHISPER_TAG="${WHISPER_TAG:-v1.7.4}"
MODEL_NAME="${WHISPER_MODEL_NAME:-ggml-large-v3-turbo.bin}"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="$ROOT/build/bin"
MODEL_DIR="$ROOT/build/models"
WHISPER_BIN="$BIN_DIR/whisper-cli"
MODEL_PATH="$MODEL_DIR/$MODEL_NAME"

mkdir -p "$BIN_DIR" "$MODEL_DIR"

SILERO_VAD_PATH="$MODEL_DIR/silero-vad.onnx"
SILERO_VAD_URL="https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx"

if [ "${FORCE:-0}" = "1" ]; then
  rm -f "$WHISPER_BIN" "$MODEL_PATH" "$SILERO_VAD_PATH"
fi

# ─── Model ────────────────────────────────────────────────────────────────────
if [ ! -s "$MODEL_PATH" ]; then
  echo "→ downloading $MODEL_NAME …"
  curl -L --fail --progress-bar -o "$MODEL_PATH.partial" "$MODEL_URL"
  mv "$MODEL_PATH.partial" "$MODEL_PATH"
  echo "  $(du -h "$MODEL_PATH" | cut -f1) at $MODEL_PATH"
else
  echo "✓ model already present: $MODEL_PATH ($(du -h "$MODEL_PATH" | cut -f1))"
fi

# ─── whisper-cli ──────────────────────────────────────────────────────────────
if [ ! -x "$WHISPER_BIN" ]; then
  echo "→ building whisper.cpp $WHISPER_TAG from source …"
  if ! command -v cmake >/dev/null 2>&1; then
    echo "ERROR: cmake is required (brew install cmake)" >&2
    exit 1
  fi

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  cd "$TMP"
  git clone --depth 1 --branch "$WHISPER_TAG" https://github.com/ggml-org/whisper.cpp.git
  cd whisper.cpp
  # BUILD_SHARED_LIBS=OFF → statically link libwhisper / libggml so we can ship
  # a single self-contained whisper-cli binary (no dylibs to chase).
  cmake -B build \
    -DCMAKE_BUILD_TYPE=Release \
    -DGGML_METAL=ON \
    -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_TESTS=OFF \
    -DWHISPER_BUILD_SERVER=OFF
  cmake --build build -j --config Release

  # whisper.cpp v1.7+ produces build/bin/whisper-cli; older versions called it main.
  if [ -x build/bin/whisper-cli ]; then
    cp build/bin/whisper-cli "$WHISPER_BIN"
  elif [ -x build/bin/main ]; then
    cp build/bin/main "$WHISPER_BIN"
  else
    echo "ERROR: could not find built whisper-cli (looked at build/bin/whisper-cli, build/bin/main)" >&2
    exit 1
  fi
  chmod +x "$WHISPER_BIN"
  cd "$ROOT"
  echo "✓ built: $WHISPER_BIN"
else
  echo "✓ whisper-cli already present: $WHISPER_BIN"
fi

# ─── silero-vad ───────────────────────────────────────────────────────────────
if [ ! -s "$SILERO_VAD_PATH" ]; then
  echo "→ downloading silero-vad.onnx …"
  curl -L --fail --progress-bar -o "$SILERO_VAD_PATH.partial" "$SILERO_VAD_URL"
  mv "$SILERO_VAD_PATH.partial" "$SILERO_VAD_PATH"
  echo "  $(du -h "$SILERO_VAD_PATH" | cut -f1) at $SILERO_VAD_PATH"
else
  echo "✓ silero-vad already present: $SILERO_VAD_PATH ($(du -h "$SILERO_VAD_PATH" | cut -f1))"
fi

echo
echo "ready:"
echo "  bin:        $WHISPER_BIN"
echo "  model:      $MODEL_PATH"
echo "  silero-vad: $SILERO_VAD_PATH"
