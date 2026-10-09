---
paths:
  - "services/voice/**"
  - "services/telegram/**"
  - "services/llm/**"
  - "scripts/telegram-poll.ts"
  - "scripts/mlx_transcribe.py"
  - "app/api/telegram/**"
  - "docs/telegram-commands.md"
---

# Telegram Bot + Voice Capture

Handlers live in `services/telegram/`; both the local poll listener
(`scripts/telegram-poll.ts`, `pnpm telegram:poll` — zero-infra,
long-polling, recommended for self-hosting) and the webhook route
(`app/api/telegram/webhook`) drive the same `dispatchTelegramUpdate`. Text
commands work with no LLM/Whisper setup; a voice note lazily invokes local
transcription + the LLM layer. Run exactly ONE update channel at a time —
poll XOR webhook, never both (Telegram allows a single update channel).

**User-facing command reference:
[`../../docs/telegram-commands.md`](../../docs/telegram-commands.md)** —
keep it in sync with `services/telegram/commands.ts` when commands change.
Commands: `/weight`, `/bf`, `/sweat`, `/week`, `/undo`, `/sync`, `/route`
(see `.claude/rules/premium-parity.md` for the route builder),
`/maintained`, and `/trim_<n>` / `/keep_<n>`. The last two resolve a
missed-stop suggestion (MZY-254, `services/missedStops.ts`). The post-sync
pass sends the nudge to `TELEGRAM_OWNER_CHAT_ID`; there are no inline
buttons, because Telegram makes `/cmd_<n>` in a message tap-to-send.

## Qualitative run-log capture shape

Captured via voice note, parsed by the LLM layer into structured JSON:

```json
{
  "distance_km": null,
  "perceived_effort": null,
  "shoe_used": null,
  "fueling": [
    {
      "product": null,      // matched against fueling_products.name; unmatched → flagged for catalog add
      "quantity": null,     // servings, fractional allowed ("half a Powerade" → 0.5)
      "timing_km": null
    }
  ],
  "pain_or_discomfort": {
    "location": null,
    "onset_km": null,
    "severity": null
  },
  "general_notes": null
}
```

Auto-classifies lift/run/body from the transcript before parsing into the
matching typed shape; unmatched fueling products get flagged, never guessed
(same pattern as the nutrition foods catalog — see
`.claude/rules/nutrition.md`).

Reference: OpenAI Whisper pricing (for the hosted `openai` transcription
fallback): https://openai.com/pricing
