# 0001 — Engineering rules: distil the framework base, enforce what a tool can check

- **Status:** proposed, 2026-10-08 (draft branch; accepted in hephaistos the
  same day)
- **Issue:** MZY-6 (Linear, hephaistos project; covers both repos)
- **Next review:** 2027-01-08 (MZY-299)

## Context

agon never imported `~/dev/ai-framework/CLAUDE.base.md`. Its CLAUDE.md
mirrors the sihha benchmark instead, and two of the guard-rails it lists
weren't true on 2026-10-08:

- **"File-size budgets in CI":** the budget script existed (a ratchet), but
  the repository had no CI.
- **"Prettier + pre-commit":** there is no pre-commit hook, and 107 files fail
  `pnpm format:check`.

What else the repository showed on 2026-10-08:

- **`pnpm lint` covered only part of the code.** It ran `next lint`, which
  scans only `app/`, `components/` and `lib/`. `services/` and `scripts/`
  were never linted, and held 3 errors (dead code, a missing env setting).
- **90 functions exceed a cyclomatic complexity of 10.**
- **`pnpm audit --prod` reports 36 advisories**, 3 of them critical (next,
  proxy-addr) and 14 high.
- **155 of 159 commits carry Co-Authored-By lines.**

hephaistos made the same decision the same day:
`docs/decisions/0001-engineering-rules-baseline.md` in that repo has the full
reasoning and the alternatives that were rejected. The decision below applies
it to agon.

## Decision

1. **Checked by tools**, in CI on every PR (`.github/workflows/check.yml`):
   - **typecheck.**
   - **lint over every source directory**, with complexity over 10 as a
     warning. `--max-warnings 90` is a ratchet: the count may only go down.
   - **`pnpm budget:files`.**
   - **unit tests.**
   - **`pnpm audit --prod --audit-level high`**: blocking since MZY-298
     fixed the advisories found on adoption.
2. **Judgment rules** no tool can check live in `.claude/rules/engineering.md`,
   always loaded and written in agon's conventions (zod at the boundary, pino,
   `services/llm/`).
3. **Not adopted:** the D0–D7 pipeline as a process. The D0 threat-model
   questions are kept for changes that cross a trust boundary.
4. **Attribution:** commits never carry `Co-Authored-By` lines.

## Open items, each its own change

- ~~Fix the 3 critical and 14 high production advisories, then make the audit
  step blocking~~ (done in MZY-298: next 15.5.27, MCP SDK 1.32.1, a postcss
  override).
- One `pnpm format:write` commit, then add `pnpm format:check` to CI.
- Decide whether to add the pre-commit hook the sihha section describes, or
  remove that claim.

## Sources

The same as hephaistos's decision 0001: Richards & Ford (fitness functions,
architecture decisions), Ousterhout (consistency, deep modules), Thomas & Hunt
(DRY, the starter kit, pragmatic process), Larson (policy and exceptions),
Huyen (memory tiers), Shostack (the four questions).
