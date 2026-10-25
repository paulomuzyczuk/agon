# syntax=docker/dockerfile:1
# Voice notes on Linux: the stock bot image plus ffmpeg, whisper.cpp and a ggml model, so
# AGON_TRANSCRIPTION_PROVIDER=whisper-cpp works INSIDE the bot container (the transcription runs
# in the long-poll process, so host-installed binaries are invisible to it).
# Built through docker-compose.voice.yml, which hands this file the stock image as `agon_base`.
# CPU build; whisper.cpp's CUDA build would need the NVIDIA runtime in the bot container too.
#
# Everything fetched at build time is pinned: whisper.cpp to a commit (tag v1.9.5), the model to a
# Hugging Face revision and a sha256 per size. To bump, change the pins together and re-check the
# hashes against the model repo's LFS metadata.

ARG WHISPER_CPP_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
ARG WHISPER_MODEL=medium
ARG WHISPER_MODEL_REV=5359861c739e955e79d9a303bcbc70fb988958b1

FROM node:22-slim AS whisper-build
ARG WHISPER_CPP_COMMIT
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /w
RUN git init -q . \
    && git fetch -q --depth 1 https://github.com/ggml-org/whisper.cpp "${WHISPER_CPP_COMMIT}" \
    && git checkout -q FETCH_HEAD
# On aarch64 (an ARM Linux host, or Docker Desktop on Apple Silicon) ggml's native CPU detection
# enables fp16fml but not fp16, and gcc 12 then fails to compile ggml-cpu ("target specific option
# mismatch" on vfmaq_f16). Turn detection off there; amd64 keeps it, as tested.
RUN native=""; [ "$(uname -m)" = "aarch64" ] && native="-DGGML_NATIVE=OFF"; \
    cmake -B build -DBUILD_SHARED_LIBS=OFF -DCMAKE_BUILD_TYPE=Release $native \
    && cmake --build build -j"$(nproc)" --config Release --target whisper-cli

FROM node:22-slim AS whisper-model
ARG WHISPER_MODEL
ARG WHISPER_MODEL_REV
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN case "${WHISPER_MODEL}" in \
      tiny)   sha=be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21 ;; \
      base)   sha=60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe ;; \
      small)  sha=1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b ;; \
      medium) sha=6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208 ;; \
      *) echo "AGON_WHISPER_MODEL must be tiny, base, small or medium (got: ${WHISPER_MODEL})" >&2; exit 1 ;; \
    esac \
    && curl -fL --retry 3 -o /model.bin \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODEL_REV}/ggml-${WHISPER_MODEL}.bin" \
    && echo "${sha}  /model.bin" | sha256sum -c -

FROM agon_base
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=whisper-build /w/build/bin/whisper-cli /usr/local/bin/whisper-cli
# One stable path whatever the model size, so AGON_TRANSCRIPTION_MODEL never has to change.
COPY --from=whisper-model /model.bin /opt/whisper/models/model.bin
USER node
