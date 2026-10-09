# Your Training Program

Agon's training-program templatization is deliberately light-touch: a
documented example file, not a generic program schema/DSL. This page
explains why, and exactly what to edit for your own program.

## Two files, two jobs

- **`docs/training-program.local.md`** (copy of
  `docs/training-program.example.md`, gitignored) — the human-readable
  description of your program: blocks, weekly volume, session types, HR
  caps. This is documentation. Nothing in the app parses this file.
- **`lib/training/trainingProgram.ts`** — the *executable* encoding of that program:
  `BLOCK_1`/`BLOCK_2`/`BLOCK_3` (or however many blocks you run), each a
  weekly template (one row per session) plus a weekly-volume table. This is
  what `scripts/seed-planned-sessions.ts` actually expands into
  `planned_sessions` rows, and what drives the training-load/compliance
  marts.

**Edit both, together, when you set up your own program.** Keep the doc as
the human source of truth and the TypeScript as what the machine reads — the
same discipline the original athlete's own program follows (see
`lib/training/trainingProgram.ts`'s own header comment).

## Why not a generic schema?

A DSL general enough to express *any* possible training program (arbitrary
block counts, arbitrary weekly structures, arbitrary progression rules) is a
real, separate project — CLAUDE.md already backlogs a
Liftoscript-inspired progression-rule mini-schema as future work, distinct
from this. Building it here, before a second real program has ever run
through this app, would be solving a problem this project hasn't
actually hit yet (`wiki/topics/sre-simplicity.md`'s essential-vs-accidental
complexity framing). Every athlete needs *some* program (essential
complexity); a schema flexible enough for every possible program is
accidental complexity relative to that need. Hand-editing one TypeScript
file for your own program is the simpler, more honest trade-off for now.

## What to edit

1. **`config/athlete-profile.local.json`** — `trainingStartDate`,
   `programWeeksPerBlock`, `programBlockCount`. These three drive block/week
   stamping (`lib/training/trainingBlocks.ts`) for every ingested run and every
   planned session — get them right first.
2. **`lib/training/trainingProgram.ts`** — replace `BLOCK_1`/`BLOCK_2`/`BLOCK_3`
   (`BlockPlan` objects: a `template` array of `TemplateSlot`s + a
   `weeklyVolumeKm` array) with your own. `PROGRAM_SESSION_COUNT` and a
   startup guard both cross-check the `BLOCKS` array length against
   `programBlockCount` — if they disagree, the app throws a clear error at
   import time rather than silently seeding a mismatched program.
3. **`docs/training-program.local.md`** — describe what you just encoded, in
   the same table shape as the example file, for your own future reference.
4. **`lib/training/sessionDetails.ts`** (optional) — per-session-type detail (e.g.
   exercise selection for lift sessions, interval structure for quality
   runs) rendered into Google Calendar event descriptions, if you use that
   integration.
5. Re-seed: `pnpm seed:planned` (idempotent — upserts on `plan_key`, safe to
   re-run after edits).

## Testing your changes

`__tests__/lib/training/trainingProgram.test.ts` and `__tests__/lib/training/trainingBlocks.test.ts`
assert against the *original* athlete's specific program (anchor date,
week/block counts, session mix) — they're fixtures for that one program, not
a generic contract. If you change `lib/training/trainingProgram.ts` for your own
program, expect those two test files to need rewriting against your own
program's shape; they aren't meant to pass unmodified for a different
program.
