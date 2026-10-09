#!/usr/bin/env python3
"""Local, offline speech-to-text for Agon voice notes.

Mirrors the pygmalion project's transcription stack: OpenAI Whisper via Apple's
MLX (`mlx-whisper`), running fully offline at transcription time (model weights
are fetched once from Hugging Face, then cached locally). Reads an audio file and
prints a single JSON object `{"text": "..."}` to stdout — the TypeScript adapter
services/llm/adapters/mlxWhisperTranscription.ts shells out to this.

    python3 scripts/mlx_transcribe.py <audio-path> [--model <hf-repo>]

Requires mlx-whisper (see scripts/requirements-transcription.txt) and ffmpeg on
PATH (`brew install ffmpeg`). No network client is imported here, so raw audio
never leaves the machine — same privacy guarantee as pygmalion.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

# Medium model: the accuracy tier pygmalion settled on — worth it for correct
# product/exercise names, which the downstream LLM parse then keys on.
DEFAULT_MODEL = "mlx-community/whisper-medium-mlx"

SUPPORTED_SUFFIXES = {".m4a", ".mp3", ".wav", ".aac", ".ogg", ".oga", ".flac"}


def require_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        sys.exit(
            "mlx_transcribe: ffmpeg not found on PATH — install it "
            "(`brew install ffmpeg`); Whisper needs it to decode audio"
        )


def transcribe(audio_path: Path, model: str) -> str:
    if not audio_path.is_file():
        sys.exit(f"mlx_transcribe: no such file: {audio_path}")
    if audio_path.suffix.lower() not in SUPPORTED_SUFFIXES:
        sys.exit(
            f"mlx_transcribe: unsupported audio format {audio_path.suffix!r} "
            f"(supported: {', '.join(sorted(SUPPORTED_SUFFIXES))})"
        )
    require_ffmpeg()
    # Imported late so `--help` and arg validation work without the heavy dep.
    import mlx_whisper

    result = mlx_whisper.transcribe(str(audio_path), path_or_hf_repo=model)
    return str(result.get("text", "")).strip()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Local mlx-whisper transcription (prints JSON to stdout)"
    )
    parser.add_argument("audio", type=Path, help="path to the audio file")
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Hugging Face repo of the MLX Whisper model (default: {DEFAULT_MODEL})",
    )
    args = parser.parse_args()
    text = transcribe(args.audio, args.model)
    json.dump({"text": text}, sys.stdout)


if __name__ == "__main__":
    main()
