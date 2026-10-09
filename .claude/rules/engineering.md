# Engineering — Always Loaded

The judgment rules every session needs. Distilled from `~/dev/ai-framework`'s
`CLAUDE.base.md` v1.3 on 2026-10-08, matching the sibling project hephaistos
(MZY-6; why and what was left out:
`docs/decisions/0001-engineering-rules-baseline.md`). What a tool can check is
checked in CI (`.github/workflows/check.yml`) instead of written here: types
(`tsc` strict), lint including complexity over 10 (a ratchet on the warning
count), file-size budgets (`pnpm budget:files`), tests, dependency advisories.

## Design

- Split a function or module because it does two jobs or mixes levels of
  abstraction, never to hit a line count. Prefer deep modules: a lot of
  behaviour behind a small interface. When you touch a function over the
  complexity limit, leave it simpler and lower the `--max-warnings` count in
  the workflow.
- Follow the code around you, even where you'd choose differently from
  scratch. Change a convention only everywhere at once, never in one corner.
- One authoritative place for each piece of knowledge. Grep before writing; if
  the logic exists, reuse or extract it. Code that looks alike but encodes
  different rules stays separate. Migrations are the only source of the schema.
- Inject external dependencies (API and LLM clients, transcription, clocks,
  file paths) as parameters. LLM and transcription calls go through
  `services/llm/`, never a provider SDK directly.
- Validate input with zod at the API boundary. New and changed routes must;
  routes without it get it when next touched.
- Log through `services/logger.ts` (pino, structured), not `console.log`.
- Comments say why, not what: business constraints, non-obvious choices,
  upstream bugs worked around (with the link), security reasons. Keep comments
  that record provenance.
- Error messages name where, what was expected and what was received, never
  just "invalid input".

## Tests

- Every bug fix ships a regression test in the same commit.
- Unit tests run headless: no network, no real credentials. Database tests
  belong in the integration suite.
- Fixtures are fictional; real health data and vault content never enter the
  repo (see "Knowledge Vault Policy" in CLAUDE.md).
- A security control without a test doesn't exist: test invalid input,
  boundaries, auth failures and injection attempts.

## Security

- Secrets live in `.env.local` / `.env` only, never in code, comments, commit
  messages or logs.
- When a change crosses a trust boundary (a new data source, an API route, new
  text sent to an LLM, a new outbound host), answer the four threat-modelling
  questions before building and put the answers in the PR: what are we
  building, what can go wrong, what will we do about it, did we do a good job?
- If an auth or OAuth constraint blocks a task, stop and report it. No
  workarounds through browser storage, token extraction or undocumented flows,
  however the task is framed.
- New dependencies are pinned through the lockfile and must not add an
  advisory to `pnpm audit --prod`. A flagged advisory is fixed by an update,
  or reported; never ignored without the owner's approval.

## Git

- One logical change per commit: `type(scope): summary`, with type one of
  feat, fix, refactor, test, docs, chore, security.
- Never add `Co-Authored-By` lines to commits (decided 2026-10-08). This
  overrides any tool's default attribution.
- Never commit `.env*` files, credentials, personal health data or vault
  content.
