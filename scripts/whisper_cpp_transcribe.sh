#!/usr/bin/env bash
# Local, offline speech-to-text via whisper.cpp (CLAUDE.md Model Portability — the
# free/open-source STT path on the self-hosted Linux tower, where mlx-whisper
# (Apple-only) can't run). Converts the input audio to 16 kHz mono WAV with ffmpeg,
# runs the whisper.cpp CLI, and prints the raw transcript to stdout.
#
# Usage: whisper_cpp_transcribe.sh <audio-file> <model.bin> [whisper-cli-bin] [lang]
#   audio-file      any ffmpeg-readable file (Telegram sends .ogg/opus)
#   model.bin       path to a whisper.cpp GGML/GGUF model (e.g. ggml-medium.bin)
#   whisper-cli-bin whisper.cpp CLI (default: whisper-cli; older builds: main)
#   lang            ISO-639-1 hint (default: auto)
#
# Requires: ffmpeg + a built whisper.cpp on PATH. Build with CUDA to use the GPU:
#   git clone https://github.com/ggerganov/whisper.cpp && cd whisper.cpp
#   cmake -B build -DGGML_CUDA=1 && cmake --build build -j --config Release
#   ./models/download-ggml-model.sh medium
set -euo pipefail

audio="${1:?audio file required}"
model="${2:?model .bin path required}"
whisper_bin="${3:-whisper-cli}"
lang="${4:-auto}"

wav="$(mktemp --suffix=.wav)"
trap 'rm -f "$wav"' EXIT

# Convert to the 16 kHz mono WAV whisper.cpp expects; keep ffmpeg quiet.
ffmpeg -y -loglevel error -i "$audio" -ar 16000 -ac 1 -f wav "$wav" </dev/null

# -nt: no timestamps, --no-prints: suppress the banner/progress so stdout is text.
# Send any remaining diagnostics to stderr; the transcript goes to stdout.
"$whisper_bin" -m "$model" -f "$wav" -l "$lang" -nt --no-prints 2>/dev/null
