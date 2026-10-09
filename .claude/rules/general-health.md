---
paths:
  - "app/health/**"
  - "services/labResults.ts"
  - "services/routines.ts"
  - "services/medications.ts"
  - "services/injuries.ts"
  - "services/medicalVisits.ts"
  - "services/vaccinations.ts"
  - "services/healthConditions.ts"
  - "lib/labTrends.ts"
  - "lib/labImport.ts"
  - "components/GeneralHealthCreateForms.tsx"
  - "components/LabTrendChart.tsx"
  - "migrations/20260824010000_general_health.sql"
  - "migrations/20260825000000_lab_results_upsert_key.sql"
  - "migrations/20260825010000_lab_results_confidence.sql"
  - ".claude/skills/lab-ingestion/**"
  - "scripts/import-lab-results.ts"
---

# General Health — Test Results, Routines, Medications & More

Full build narrative: tracked in Linear ("General Health" issues). This
extends Agon into life domains beyond sports (skincare/dental, lab tests,
medications, injuries, medical/dental visits, vaccinations, allergies/
chronic conditions). **Vision was explicitly scoped out per athlete
direction.** Same conventions as `nutrition_goals.goal_key`: any open-ended
vocabulary (test marker names, panel/visit types, body parts, vaccine
names) is TEXT, not a CHECK enum. No numeric reference values are
hardcoded — lab reference ranges are entered per-result (a lab report
prints its own).

- **`lab_panels` / `lab_panel_results`** — any test event (blood panel,
  spermogram, hormone panel, urinalysis, ...) as a header row + one row per
  marker. A result carries `value_numeric` and/or `value_text` (qualitative
  results like blood type or a morphology grade are representable) plus an
  optional reference range and a `low/normal/high/abnormal` flag.
  `services/labResults.ts` (`logLabPanel`, `listLabPanels`,
  `getMarkerTrend`).
- **Ingestion + trend chart mirror sihha's psychometric-results pattern**
  (public repo `~/repos/sihha-public`). Idempotent natural-key upsert:
  `UNIQUE(lab_panel_id, marker)` + a `source_file` column for provenance;
  `logLabPanel` upserts (`ON CONFLICT ... DO UPDATE`).
  `scripts/import-lab-results.ts` (`pnpm import:labs <csv>`) mirrors
  sihha's psychometrics importer file-for-file: a flattened CSV upserts
  idempotently, so a corrected re-import overwrites in place. Goes through
  Agon's own plain-`pg` `services/db.ts`, not `@supabase/supabase-js` (Agon
  already decided against the Supabase SDK).
- **Cross-marker trend chart** (`lib/labTrends.ts`: `buildLabTrends`,
  `latestLabReadings`, pure, unit-tested): normalizes each value to its
  position within `[reference_low, reference_high]` as a 0–100 axis (0 = low
  bound, 100 = high bound; clamped to [-50,150] display band) — the analog
  of sihha's `buildScaleTrends` [min,max] normalization (labs have no
  cross-instrument percentile equivalent). A marker missing either bound, or
  with only a qualitative `value_text`, doesn't chart. Series key is
  `panel_type · marker`. `components/LabTrendChart.tsx` is a self-contained
  inline-SVG file (Agon's own convention, no charting dependency).
- **`GET /api/general-health/lab-trends`** returns every result flat and
  unlimited — unlike `/api/general-health`'s `recentLabPanels`, capped at
  the last 20 panels. `services/marts/health.ts` → `getLabTrends()` →
  `listLabResultsFlat()`.
- **PDF upload → skill-driven extraction → review flag**
  (`.claude/skills/lab-ingestion/SKILL.md`, ported from sihha's identical
  skill): reads an uploaded PDF directly (native PDF reading, no OCR
  library or LLM API call from application code) and extracts it into a
  confidence-scored CSV, which the idempotent importer ingests.
  - **No `lab_documents` table / Storage bucket / upload API** (unlike
    sihha) — no multi-user upload flow to gate: the PDF just lives on the
    local filesystem, `lab-reports/` (gitignored, PHI), moved to
    `lab-reports/processed/` after import so a re-scan doesn't re-offer it.
    "Uploading" is placing the file where Claude Code can read it, not a
    web form.
  - **`confidence` / `needs_review` / `model` columns** on
    `lab_panel_results` mirror sihha's columns exactly: the skill
    self-assesses 0–1 confidence per extracted row per a 3-tier rubric
    (machine-printed clear / legible-with-a-judgement-call /
    poor-scan-or-doubtful), rows under `AGON_LAB_OCR_CONFIDENCE_MIN`
    (default 0.85) get `needs_review = true`. Confidence is optional in the
    CSV (blank = null = manually entered/verified, never flagged) since
    Agon's importer also serves hand-typed corrections.
  - **No admin e-mail** (unlike sihha's low-confidence alert) — Agon has no
    e-mail/alerting-ledger infra, single-user. Pure CSV/threshold logic
    lives in `lib/labImport.ts` (`parseLabCsv`, `rowsNeedingReview`,
    `buildReviewSummary`, unit-tested) so the import script stays a thin CLI
    wrapper printing the review summary to stdout for the invoking skill
    session to relay directly to the athlete. `pnpm import:labs <csv>
    [--model <id>]`.
  - `needs_review` surfaces as a "· needs review" tag (amber) on the flat
    panel list and the trend chart's legend/pinned-point balloon.
- **`routines` / `routine_steps` / `routine_logs`** — skincare + dental
  habit tracking, mirroring `meal_templates`/`meal_logs`: a reusable routine
  (`routine_type` skincare/dental, ordered `routine_steps`) plus a daily
  adherence log (`UNIQUE(date, routine_id)` — re-logging the same day
  upserts). `services/routines.ts`; the PWA's `/health` view has a one-tap
  "Done today" action per routine, and shows 7-day adherence.
- **`medications` / `medication_logs`** — a general medication + supplement
  ledger, deliberately scoped to what `nutrition_goals` does NOT already
  cover: creatine, vitamin C, zinc, vitamin D, and water all already have
  goal rows + a place to log against them, so this ledger is for everything
  else — prescriptions, topical/skincare-adjacent meds (tracked as routine
  steps, not here), and any other OTC medication or supplement. `active`
  flags what's currently being taken without deleting history.
  `services/medications.ts`.
- **`injuries` / `injury_updates`** — a standalone injury/pain tracker with
  a status timeline (`active`/`improving`/`resolved`), distinct from
  `runs.pain_location` (in-run-only). `services/injuries.ts`.
- **`medical_visits`** — doctor/dentist/specialist appointments: provider,
  reason, findings, optional `follow_up_date`. `visit_type` is open text (a
  dental checkup is just a visit_type, not a separate table).
  `services/medicalVisits.ts`.
- **`vaccinations`** — append-mostly immunization record with an optional
  `next_due_date`. `services/vaccinations.ts`.
- **`health_conditions`** — allergies + chronic conditions,
  `UNIQUE(condition_type, name)` so re-logging upserts status/severity.
  Mainly consulting-layer context (so Claude knows constraints when giving
  advice), not a time series. `services/healthConditions.ts`.
- **MCP tool — `health_summary`** (no args): out-of-range lab results
  first (the triage-relevant view), recent test panels, active injuries,
  active medications/supplements, active allergies/chronic conditions,
  7-day skincare/dental routine adherence, and upcoming medical-visit/
  vaccination follow-ups. Reimplemented on the read-only pool.
- **PWA view — `/health`** (`app/health/page.tsx` → `/api/general-health` →
  `services/marts/health.ts`, write path `/api/general-health/log`; named
  `general-health` rather than `health` because `/api/health` is the
  liveness/DB-reachability probe n8n/uptime monitoring pings): routine
  adherence with the one-tap "Done today" action, recent test results
  (color-flagged out-of-range), active injuries/medications/conditions, and
  recent visits + upcoming follow-ups. No dbt mart backing it — current-state
  operational data, reads the operational tables directly.
  `components/GeneralHealthCreateForms.tsx` is a type-switcher over 7 small
  creation forms (lab panel, medication, injury, medical visit,
  vaccination, allergy/condition, new routine), all posting to
  `/api/general-health/log` (mode-discriminated, mirrors
  `/api/nutrition/log`).
- **Still open**: Telegram capture commands for the high-frequency items
  (routine adherence, medication doses) — see Linear (MZY-34). No dbt marts
  (nothing here is a meaningful time series yet at this data volume).
