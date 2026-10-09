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
3. Find your own chat id (used only for the data-freshness alert, optional):
   send the bot any message, then visit
   `https://api.telegram.org/bot<token>/getUpdates` and read the `chat.id`
   field. Set `TELEGRAM_OWNER_CHAT_ID` in `.env.local`.

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
pull qwen2.5:7b`). Transcription still defaults to `mlx-whisper`
(Apple-Silicon-only, for this project's own dev machine) — inside Docker on
Linux switch it to `whisper-cpp` (same `local-ai` profile) or the hosted
`openai` fallback. Swapping the LLM side to `claude-cli` (needs the `claude`
CLI installed and logged in *on the host running the bot container*, or its
credentials mounted in) or hosted `anthropic` (BYOK) is always available but
never required.
