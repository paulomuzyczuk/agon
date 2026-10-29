# Telegram Bot Setup

The bot is Agon's low-friction capture path — voice notes, `/weight`,
`/sync`, `/route`, and more. Full command reference:
[`../telegram-commands.md`](../telegram-commands.md).

## 1. Create the bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram: `/newbot`,
   follow the prompts, and copy the token it gives you.
2. Set in `.env.local`:
   ```sh
   TELEGRAM_BOT_TOKEN=<token from BotFather>
   ```
3. Find your own chat id (used for alerts and reminders, optional): start the
   bot (next section), send it `/whoami`, and it replies with the id and the
   exact line to add. Set `TELEGRAM_OWNER_CHAT_ID` in `.env.local` and restart
   the `bot` service. (Calling `getUpdates` by hand only works while the bot is
   stopped; a running bot consumes the updates first.)

## 2. Run it

`docker-compose.yml`'s `bot` service runs the **long-poll listener**
(`tsx scripts/telegram-poll.ts`) — this is the recommended mode for
self-hosting: the bot dials out to Telegram, so it needs **no public URL,
port-forwarding, or TLS**. Nothing about the bot is exposed through your
router.

```sh
docker compose --env-file .env.local up -d bot
docker compose --env-file .env.local logs -f bot
```

Send the bot `/week` — you should get a reply.

> Run exactly **one** update channel — long-poll listener *or* the webhook
> route (`app/api/telegram/webhook`), never both. The webhook path needs a
> public URL and `TELEGRAM_WEBHOOK_SECRET` (`pnpm bootstrap` already
> generated one); it exists for a deploy shape with a reverse proxy already
> in front of the app, which most self-hosters won't have — stick with the
> long-poll `bot` service unless you know you want the webhook.

## 3. Voice notes (optional)

Voice-note transcription + parsing needs one LLM provider and one
transcription provider configured — see `.env.example`'s `AGON_LLM_PROVIDER`
/ `AGON_TRANSCRIPTION_PROVIDER` sections. The LLM side defaults to `ollama`
(no vendor account, no API key, no lock-in) — bring it up with
`docker-compose.yml`'s `local-ai` profile (`docker compose --env-file
.env.local --profile local-ai up -d ollama`, then `... exec ollama ollama
pull qwen2.5:7b`).

**Transcription runs inside the `bot` container**, so whatever it needs has to
be inside that image — a `whisper-cli` or `ffmpeg` on your host is invisible
to it. The default `mlx-whisper` is Apple-Silicon-only. Pick one:

- **Local, Linux (recommended):** the opt-in voice overlay builds a bot image
  with `ffmpeg`, whisper.cpp and a model (about 1.5 GB for the default
  `medium`; `AGON_WHISPER_MODEL=small` is ~470 MB). Audio never leaves your
  machine. The whisper.cpp source and the model are pinned and the model is
  checked against a sha256 at build time. In `.env.local`:
  ```sh
  AGON_TRANSCRIPTION_PROVIDER=whisper-cpp
  AGON_TRANSCRIPTION_MODEL=/opt/whisper/models/model.bin
  ```
  then (the first build compiles whisper.cpp and takes a few minutes):
  ```sh
  docker compose -f docker-compose.yml -f docker-compose.voice.yml \
    --env-file .env.local up -d --build bot
  ```
  Use the same two `-f` flags for every later `up`/`restart` of `bot`, or
  Compose goes back to the stock image. The CPU build transcribes a short note
  in a few seconds on a modern desktop CPU.
- **Hosted:** `AGON_TRANSCRIPTION_PROVIDER=openai` with
  `AGON_TRANSCRIPTION_API_KEY` (your voice notes are sent to OpenAI).
- **Bot on the host, not in Docker** (`deploy/agon-bot.service`): install
  `ffmpeg` and build whisper.cpp on the host instead; no overlay needed.

Swapping the LLM side to `claude-cli` (needs the `claude` CLI installed and
logged in *on the host running the bot container*, or its credentials mounted
in) or hosted `anthropic` (BYOK) is always available but never required.
