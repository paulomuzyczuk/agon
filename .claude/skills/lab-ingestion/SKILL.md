---
name: lab-ingestion
description: Extract the figures from a lab-report PDF dropped in lab-reports/ into lab_panels/lab_panel_results, with per-row extraction confidence and a review flag for doubtful values. Use whenever the user asks to process a lab report, mentions a new blood test/panel/PDF, or when unprocessed PDFs exist in lab-reports/.
---

# Lab report ingestion

Turns a lab-report PDF into rows of `lab_panel_results` — the flat, chartable
shape (one row per marker) that backs `/health`'s trend chart and MCP
`health_summary` — via `pnpm import:labs`, which flags any extraction below
the confidence threshold as `needs_review` instead of silently trusting it.

Adapted from sihha's `lab-ingestion` skill for Agon's single-user,
self-hosted posture: no upload API, no Storage bucket, no admin e-mail — the
PDF lives on the local filesystem and this skill reports low-confidence rows
straight back to the athlete's own session.

## Privacy — read first

Everything in `lab-reports/` is medical PHI and **gitignored on purpose**
(see `.gitignore`). Never commit a PDF or an extracted CSV, never weaken that
ignore rule, and never paste identifying content into a commit or PR message.
The data's only durable home is `lab_panel_results`.

## Canonical flat CSV

One CSV per document, named `<test-date>-<panel-type>.csv`, with exactly this
header (see `lib/labImport.ts` `LAB_CSV_HEADER` — the importer rejects any
other header):

```
date,panel_type,lab_name,marker,value_numeric,value_text,unit,reference_low,reference_high,flag,confidence,source_file
```

- `date` — the sample-collection date printed on the report, `YYYY-MM-DD`
  (prefer collection date over print/report date when both appear).
- `panel_type` — open text, lowercase-with-underscores (e.g.
  `blood_general`, `hormone_panel`, `spermogram`, `urinalysis`). Reuse the
  exact spelling already used in past imports — the trend chart's chip
  toggles and its `panel_type · marker` series key match by string.
- `marker` — the measure as the lab names it (e.g. `hemoglobin`,
  `testosterone`, `ldl_cholesterol`). Reuse the exact spelling from past
  imports for the same analyte — the trend chart matches markers by string,
  so a spelling drift silently starts a new, disconnected line.
- `value_numeric` — the numeric result, dot decimal separator, no thousands
  grouping. Leave empty for a qualitative result (see `value_text` below).
- `value_text` — for qualitative results only (blood type, morphology grade,
  "negative"/"positive"). Leave empty when `value_numeric` is set. A row
  needs exactly one of the two.
- `unit` — as printed (`g/dL`, `mg/dL`, `nmol/L`, ...). Empty for qualitative
  rows.
- `reference_low` / `reference_high` — the lab's own printed range. Empty
  when the report gives no range (common for qualitative markers) — a
  marker without both bounds won't chart (see `lib/labTrends.ts`), but it
  still stores and appears in the flat results list.
- `flag` — `low` / `normal` / `high` / `abnormal`, or empty. Use the
  report's own printed flag/asterisk/arrow when it has one; otherwise derive
  it by comparing the value against the reference range when both are
  present; otherwise leave empty (never guess).
- `confidence` — YOUR extraction confidence for this row, 0–1:
  - `1.0` — machine-printed, clearly legible, value and unit unambiguous
  - `0.8–0.95` — legible but with a judgement call (merged table cells, unit
    inferred from context, ambiguous decimal separator)
  - `< 0.8` — poor scan quality, handwriting, a partially cut-off number, or
    any figure you'd want a human to double-check
  Be honest and conservative: anything under the threshold (env
  `AGON_LAB_OCR_CONFIDENCE_MIN`, default 0.85) is stored `needs_review =
  true` and reported back to the athlete — a wrong lab value silently
  trusted is worse than a flagged one. Leave empty ONLY for a value you are
  reading, not estimating (empty means "fully trusted," i.e. confidence 1.0
  by default in the importer — when in doubt, put an explicit number instead
  of leaving it blank).
- `source_file` — the PDF's filename.

No commas inside any field; leave unknown cells empty.

## Workflow

1. **Find pending PDFs**:

   ```bash
   ls lab-reports/*.pdf 2>/dev/null
   ```

   (Anything still directly in `lab-reports/` is pending; anything already
   moved to `lab-reports/processed/` has been imported.)

2. **Read the PDF directly** with the Read tool — Claude reads PDFs natively
   (text or scanned/image pages), so no separate OCR step or library is
   needed.

3. **Extract every result** into the CSV at `lab-reports/<file>.csv`,
   assigning per-row confidence per the rubric above. Skip nothing silently —
   if a row can't be confidently identified as a distinct marker+value at
   all (not just low-confidence, but genuinely unreadable), omit it from the
   CSV and mention it in your report to the user instead of guessing.

4. **Import**:

   ```bash
   pnpm import:labs lab-reports/<file>.csv --model <your model id>
   ```

   The script upserts on `(date, panel_type)` for the panel header and
   `(lab_panel_id, marker)` for each result — a corrected CSV can simply be
   re-imported — and prints a review summary of any row under
   `AGON_LAB_OCR_CONFIDENCE_MIN`.

5. **Move the source PDF** to `lab-reports/processed/` once its import
   succeeds, so a re-run of step 1 doesn't re-offer it.

6. **On extraction failure** (unreadable scan, wrong document type, empty
   report), do NOT move the PDF to `processed/` — leave it pending and tell
   the user the specific reason instead of looping or guessing at values.

7. **Verify**: report how many rows were imported, across how many panels,
   and list any low-confidence markers flagged for review (the import
   script's own stdout summary has this — relay it verbatim).
