# Methodology Log

A dated log of investigative/calibration/validation exercises — threshold
sweeps, ground-truth comparisons, algorithm cross-checks, format/data-source
investigations. This is where the *how we figured it out* detail lives:
sweep tables, confusion matrices, raw findings, caveats and open questions.

CLAUDE.md stays the architecture/decision record — what exists, why, and
where it lives in the code. This file is the working notebook behind those
decisions. When CLAUDE.md cites a calibrated constant or a validated design
choice, the exercise that produced it belongs here, with CLAUDE.md carrying
only a one-line pointer back.

---

## 2026-09-05 — Moving-flag detection: GPX capabilities, threshold calibration, cadence cross-check

Context: building "estimated net pace" (stop-time-corrected pace) for the
run-detail page and the best-effort/PR pipeline, athlete-directed
(`lib/movingTime.ts`; see CLAUDE.md's Premium-Parity #2 section for how this
feeds `run_best_efforts`/`race_predictions`).

### GPX export field inventory

Question: does a *free* per-activity Strava GPX export carry a moving-time/
elapsed-time distinction, or any per-sample stop flag, as an alternative to
the paywalled Streams API?

Method: exported a real activity from Strava's website (Activity page → •••
→ Export GPX — free tier, distinct from the developer API subscription that
retired live sync) and exhaustively enumerated every distinct XML element in
the file.

**Complete element inventory**: `trkpt` (lat/lon), `ele`, `time`, and
per-point `gpxtpx:hr` / `gpxtpx:cad`. Nothing else. The `<metadata>` block
has only a start timestamp. No per-point movement flag, no declared Moving
Time / Elapsed Time summary anywhere.

**Conclusion**: a GPX-derived stream can only ever produce raw elapsed time.
`estimateNetTime`/`buildNetAdjustedStream` correctly return null for it
without a `moving` (or `derived_moving`) array supplied separately. The
Strava moving/elapsed split, and any per-sample stop flag, is confirmed
paywalled — not merely unpulled. (CLAUDE.md's Phase 2 backlog carries the
"pull it next premium month" item; this entry is the evidence behind it.)

### Speed-threshold calibration (`deriveMovingFlags`)

Question: what stop-speed threshold (m/s) best reproduces Strava's real
`moving` flag from distance/time alone?

Method: `pnpm dm:backfill` sweeps candidate thresholds against every run with
real Strava `moving` data (52 runs, 383 confirmed stops), scoring each by
per-sample accuracy and — the metric that actually matters for net-time
correction — per-confirmed-stop precision/recall (a derived stop counts as
matched if its index range overlaps a real one; exact boundaries don't need
to line up).

| m/s | sample acc | stop recall | stop precision | F1 |
|---|---|---|---|---|
| 0.3 | 98.0% | 77.5% | 100.0% | 0.87 |
| 0.4 | 98.1% | 81.2% | 100.0% | 0.90 |
| 0.5 | 98.2% | 82.0% | 100.0% | 0.90 |
| 0.6 | 98.3% | 86.7% | 100.0% | 0.93 |
| 0.7 | 98.5% | 89.6% | 100.0% | 0.94 |
| 0.8 | 98.6% | 93.2% | 100.0% | 0.96 |
| **1.0** | **98.7%** | **97.9%** | **97.7%** | **0.98** |
| 1.2 | 97.7% | 98.2% | 82.8% | 0.90 |

1.0 m/s (~3.6 km/h) is the clear best — below it, real stops get missed
(precision stays 100% because nothing gets over-flagged, but recall
suffers); above it, precision collapses because genuine slow jogging starts
getting flagged as stopped. `DEFAULT_STOP_SPEED_MPS` is set to 1.0.

**Caveat**: this calibrates the in-house method to *reproduce Strava's
flag*, which is itself confirmed noisy (see the flicker-noise finding in
CLAUDE.md's best-effort section — one 62-minute run flickered `moving=false`
for a single sample 780 times). High agreement with Strava here means "we
successfully mimicked Strava's algorithm," not "we independently verified
correctness against ground truth." That's exactly why the cadence cross-check
below exists.

### Independent cross-check: cadence vs. speed vs. Strava

Athlete's framing: *"given we already know [Strava's flag] is noisy maybe it
doesn't make much sense to use it as ground truth"* — asked for a method
built without reference to Strava at all, so the two could be compared
afterward.

The speed-threshold method and Strava's real flag both read the SAME
underlying signal (GPS speed/position) — agreement between them is weaker
evidence than it looks, since two algorithms reaching a similar conclusion
from the same input isn't independent corroboration.

`deriveMovingFlagsFromCadence` uses accelerometer-derived stride rate
instead — a mechanically different signal from GPS entirely. Its threshold
(`DEFAULT_STOP_CADENCE_SPM = 15`) was picked from cadence's own value
distribution across the dataset (110,889 samples): a real gap between a
0-9 spm cluster (2,544 samples, near-zero) and everything else (only 13
samples at 10-19 spm, then a continuous ramp into the dominant 70-89 spm
running cluster) — deliberately not tuned against Strava's flag at all.

**Important context correction (post-hoc)**: the athlete runs with a
**cellphone, not a wrist watch or footpod**. This matters a lot for how much
weight the cadence signal should carry: a phone's cadence is derived from
whatever the phone's accelerometer picks up wherever it's carried (pocket,
armband, hand) — its orientation and coupling to actual leg motion is far
looser than a wrist-worn watch (which swings with arm cadence, tightly
correlated to stride) or a chest/foot sensor. This is a more mundane, and
probably more significant, explanation for any recall gap than a genuine
"different physical phenomenon" story — it should be the leading hypothesis,
not an afterthought, and it means the absolute cadence numbers below should
be read as "phone-accelerometer-cadence vs. GPS-speed," not "true stride
rate vs. GPS-speed." A repeat of this exercise with a real wrist-worn cadence
sensor would be needed to separate signal quality from genuine physiological
difference.

`pnpm mv:compare` (read-only) on the 24 runs with both cadence and real
Strava data (cadence coverage is sparse: 25/53 streams overall):

| Comparison | Sample agreement | Stop recall | Stop precision |
|---|---|---|---|
| speed vs. Strava | 97.7% | 97.3% | 96.8% |
| cadence vs. Strava | 89.9% | 64.3% | 83.8% |
| **speed vs. cadence** (no Strava referenced) | **91.8%** | 80.8% | 62.2% |

**Reading it**: the speed-vs-cadence row is the one that matters most —
91.8% sample agreement between two mechanically unrelated signals is real
corroborating evidence that the speed method captures something genuine,
not just noise. Cadence found fewer confirmed stops overall (130 vs.
~221-222 for speed/Strava). Two candidate explanations, not mutually
exclusive, and NOT resolved by this exercise:
1. **Phone-accelerometer noise** (see correction above) — the more likely
   dominant factor, unverified without a real sensor to compare against.
2. **Genuinely different definitions** — cadence measures "are the legs
   moving," speed/distance measures "is ground being covered." Jogging in
   place at a red light or weaving slowly through pedestrians would keep
   cadence non-zero while GPS distance stalls. For this feature's actual
   purpose (correcting pace for time lost to forced stops), ground-covered
   is the physically relevant definition regardless.

**Status**: not wired into any pipeline. `pnpm mv:compare` is a standing
validation script for re-running this comparison as more cadence-carrying
runs accumulate (or after any future signal-quality investigation).

### Fitbit-wrist cadence: a second, independent cross-check

Follow-up question, same day: the phone-cadence method above found a real
recall gap vs. speed/Strava (130 confirmed stops vs. ~221-222), with the
leading hypothesis being phone-accelerometer noise (the athlete carries a
cellphone, not a wrist/foot sensor). The athlete also wears a **Fitbit Air on
the wrist** during every run — a wrist-worn accelerometer is far more tightly
coupled to arm swing (which tracks leg cadence near 1:1 while running) than a
pocketed/handheld phone. If the phone really is the noise source, a
wrist-based cadence signal should agree with GPS-speed detection *better*
than the phone did. This investigates whether that data is even available,
and if so, whether it bears out the hypothesis.

**Feasibility, live-probed.** Google Health's `steps` dataType DOES accept a
fully-qualified `steps.interval.start_time >= .. AND < ..` filter — same
grammar family as the already-verified `heart_rate.sample_time.physical_time`
— at arbitrary sub-run-window granularity, not just whole-day ranges. Within
one run's time window, THREE distinct `dataSource` combinations appear:

- `FITBIT / Google Fitbit Air` — the wrist device's own passively-measured
  steps, in clean, non-overlapping, wall-clock-minute-aligned 1-minute
  buckets (e.g. 19:44:00–19:45:00Z).
- `FITBIT / MobileTrack` — Fitbit's own phone-accelerometer fallback
  tracker. Same platform tag, but NOT the wrist — also present almost every
  time, at near-complete coverage regardless of what the wrist band recorded.
- `HEALTH_CONNECT / PHONE` (Samsung) — the phone via Android Health Connect,
  in overlapping ~1-minute rolling windows at arbitrary offsets (the same
  double-counting hazard `wellnessMap.ts` documents for the daily-rollup
  case, here scoped to one run instead of a whole day).

Filtering to `platform === 'FITBIT' && device.displayName !== 'MobileTrack'`
cleanly isolates the wrist device's own samples
(`services/googleHealth/steps.ts::isWristStepsSource`) — confirmed against
every device-name combo actually seen across 21 real runs (no fourth device
name ever appeared).

**Two real limitations found, both live-probed, neither assumable in
advance:**

1. **Native granularity is 1-minute buckets**, not sub-minute — a run's wrist
   steps come back as one bucket per wall-clock minute (e.g. a 64.7-minute
   run yields 65 buckets), far coarser than the ~1 Hz GPS/HR sample rate
   everything else in this pipeline works at. `lib/fitbitCadence.ts`
   resamples each bucket's steps/min rate onto the target stream's own
   `time_s` axis by broadcast (every sample inside a bucket's window gets
   that bucket's rate) — the only sane way to align two wildly
   different-resolution signals onto one comparable axis, but it means a
   single bucket cannot distinguish "stopped for 10s at a red light" from
   "ran the whole minute" unless the stop consumes most of that minute.
2. **Coverage is unreliable and bimodal**, not sparse-but-uniform. The wrist
   device (`Google Fitbit Air`) has **zero** steps data at all before
   2026-07-01 in this account (33 of 52 eligible runs, all pre-dating that
   day, returned no wrist buckets whatsoever — even though `MobileTrack`
   coverage, when checked, was near-complete for the same windows). Live
   coverage swept across all 52 distance-bearing, timestamped runs:

   | Coverage band | Run count |
   |---|---|
   | 0% (no wrist data at all, mostly pre-2026-07-01) | 33 |
   | 1-49% (band off-wrist / desynced for that run) | 6 |
   | >=50% (of expected 1-minute buckets present) | 13 |

   Even after 2026-07-01, coverage is bimodal, not a gentle spread: most
   qualifying runs landed at 79-100% of expected buckets, the rest at 4-27%
   — nothing in between. This reads as "the band was worn and syncing" vs.
   "the band was off-wrist, dead, or desynced for that run," not gradual
   signal degradation.

   A run below coverage forces a design choice: `resampleCadence` returns
   `null` for any target sample with no covering bucket (never inferred),
   but `deriveMovingFlagsFromCadence`'s existing "null means moving"
   convention would silently read a near-total-gap run as "never stopped" —
   an artifact of missing data, not a real second opinion. `pnpm fc:backfill`
   therefore gates writes at **>=50% bucket coverage**; below that, the
   run's `fitbit_cadence` is left null rather than persisted misleadingly.

**Threshold, calibrated from the Fitbit data's own distribution** (same
independence discipline as the phone method — never tuned against Strava):
50,740 covered samples across the 13 qualifying runs showed a clean gap with
**zero** samples between 45-49 steps/min (60 samples) and 60-64 steps/min
(180 samples) — the same "near-zero cluster, then a gap, then the running
ramp" shape the phone-cadence histogram showed, just at roughly double the
raw value (expected: Fitbit's `steps.count` is a BOTH-FEET total, not the
phone/GPX `cad` field's one-foot convention). `DEFAULT_STOP_FITBIT_CADENCE_SPM
= 50` (`lib/movingTime.ts`).

**Result — `pnpm mv:compare`, 13 runs with Fitbit-wrist cadence AND real
Strava data:**

| Comparison | Sample agreement | Stop recall | Stop precision |
|---|---|---|---|
| speed vs. Strava (same 13-run subset) | 99.9% | 97.5% | 98.3% |
| fitbit-cadence vs. Strava | 89.5% | **8.2%** | 75.0% |
| speed vs. fitbit-cadence (independent) | 89.4% | 75.0% | 8.3% |
| fitbit-cadence vs. phone-cadence (11 runs with both) | 96.6% | 7.8% | 75.0% |

(Recall here reads as "of Strava's/speed's real confirmed stops, how many did
fitbit-cadence also flag"; precision reads as "of fitbit-cadence's own
flagged stops, how many were real.")

**Reading it — this does NOT corroborate the phone-noise hypothesis, and the
answer is a clear no, for a different reason than expected.** Fitbit-wrist
cadence found only **8 confirmed stops total across 13 runs** against ~120
real ones in the same subset (recall 8.2%, vs. the phone method's 64.3% on
its own, larger 24-run subset) — dramatically *worse* agreement, not better.
The 89.5%/89.4% sample-agreement figures look superficially reasonable but
are dominated by the (correctly-classified) moving majority of samples; at
the level that actually matters for net-time correction — confirmed stops —
the wrist signal essentially misses almost everything. High per-run stop
precision (75-98.3%) alongside near-zero recall confirms the mechanism: this
is not noisy misclassification, it's the 1-minute bucket resolution
structurally unable to see stops shorter than roughly a minute, which is
most of them (typical red-light stops run 5-90s and rarely dominate a whole
wall-clock minute of otherwise-continuous running). The wrist accelerometer
may well be more tightly coupled to genuine stride motion than the phone —
this exercise can't and doesn't refute that — but it doesn't matter here: a
coarser time axis swamps whatever signal-quality advantage the sensor
location has. The original phone-signal-noise hypothesis for the earlier
64.3%-vs-97.3% recall gap remains the leading explanation, now BY
elimination rather than confirmation — the wrist alternative was tested and
independently ruled out as a better second opinion, for a reason (temporal
resolution) that has nothing to do with signal noise at all.

**Status**: `run_streams.fitbit_cadence` (migration `20260905020000`) is
populated for the 13 qualifying runs via `pnpm fc:backfill`
(`services/googleHealth/steps.ts` + `lib/fitbitCadence.ts`, both
unit-testable pure/parsing layers) and compared via the extended
`pnpm mv:compare` — not wired into `computeMovingTime`/`estimateNetTime`/the
best-effort pipeline, per the same "validate first, wire later, only if
justified" posture as the phone-cadence exercise. Given the granularity
ceiling is structural (Google Health's `steps` List method has no finer
native resolution to request), this is unlikely to improve without a
different Fitbit dataType or a firmware-level change — not pursued further
this session.

### Excluding Google-Health-only runs from the best-effort/Riegel pipeline

Follow-up, same day, athlete-directed: while reviewing why the race-prediction
page's 10K estimate came out slower than the athlete's GPS-verified 10K PR,
the underlying pair table (`services/racePrediction.ts::loadBestEffortPairs`)
showed a second ~10K point several minutes faster than that PR, with
`source = 'google_health'`, `method = 'whole_run'` — i.e. no
distance-bearing `run_streams` row backed it at all; its distance and
duration came straight from Google Health's aggregate record with nothing to
verify them against.

The athlete identified the run immediately as one of their slowest ever
(extreme heat). The data said faster than the verified PR; lived memory said
the opposite extreme. That's not measurement noise, it's a wrong data point,
most likely the Fitbit Air's GPS-less auto-detected duration/distance
mis-measuring the session (no phone-recorded track to cross-check against).

**Why this matters beyond one bad row**: `loadBestEffortPairs`'s
"beat-the-curve" filter (see the 2026-09-05 "Net-pace-corrected best
efforts" section of CLAUDE.md) exists specifically to admit `full_run`
points that outperform the bucket-only fit — i.e. it's DESIGNED to give
outliers extra weight when they look like genuine untapped capability. This
point beat the curve by the largest margin of any pair and had become the
model's VDOT reference effort. A filter built to trust surprising fast efforts has no
way to distinguish "genuinely fast" from "wrong" — provenance is the only
signal that can, and this point had none (no stream, no independent GPS
distance, nothing).

**Decision (athlete-directed): refuse the whole-run fallback entirely for
`source = 'google_health'` runs with no distance-bearing stream.** Every
other source keeps the existing fallback (a manually-logged run with no GPS
track, for instance, is the athlete's own estimate — not Fitbit-Air
auto-detection). A `google_health`-origin run that DOES have a real stream
(most of them, via the Strava-premium enrichment pass attaching a `strava`
source stream — see CLAUDE.md's "Strava-premium one-time enrichment") is
UNAFFECTED — the exclusion only fires when the stream tier finds nothing to
use at all. Implemented in `scripts/backfill-best-efforts.ts`: after
`richestDistanceStream()` returns null, a run with `source === 'google_health'`
is skipped outright (not passed to `wholeRunEffort()`), tracked in its own
`nExcludedGoogleHealthNoStream` counter, and (on `--write`) any stale rows a
prior run of the script left for now-excluded runs are pruned via the new
`deleteRunBestEfforts()` (upsert alone never removes rows for runs no
longer processed).

**Effect, `pnpm be:backfill --write` + `pnpm rp:backfill --write`:**

| | Runs | Rows |
|---|---|---|
| Stream-derived | 53 | (unaffected) |
| Whole-run fallback (non-google_health) | 4 | (unaffected) |
| **Excluded (google_health, no stream)** | **54** | **0** (was contributing whole-run rows before this rule) |

The fit kept the same number of pairs: the bogus point dropped out and a
GPS-verified ~10K pair (from a file-imported run) newly cleared the "beat the
curve" bar once the curve itself shifted. The Riegel exponent barely moved,
but the VDOT reference reverted to the physically sensible 5K split, and the
10K prediction got slightly *slower* — the curve now follows the genuine
long-distance fade instead of an impossible short-distance outlier.

**Caveat**: this rule is coarse — it excludes by `runs.source`, not by
`runs.origin` (health_connect vs. fitbit). Per `services/googleHealth/dedupe.ts`,
`health_connect`-origin records are normally the trustworthy ones (phone/
Health-Connect-sourced, matching the athlete's SOT to the metre) — and this
run WAS `origin='health_connect'`, not `'fitbit'`. That the origin tag alone
didn't guarantee accuracy here suggests Health Connect can still be fed by
the Fitbit Air's own GPS-less estimate for a run with no phone-recorded
track, not just a phone/Samsung app. A finer-grained rule (only exclude
`origin='fitbit'`, or require an actual GPS route/point count) would keep
more data but needs more investigation into what `health_connect` actually
means when no track backs it — left as a follow-up if this proves too
coarse in practice.

---

## 2026-09-25 — Strava moving/elapsed time reconciliation (MZY-40)

A Strava premium window reopened API access, so `pnpm strava:times --write`
pulled Strava's paywall-only `moving_time`/`elapsed_time` for every run/ride
activity into `public.strava_activity_times` (migration `20260925020000`,
`services/strava/activityTimes.ts`). The summary list endpoint carries both
fields, so the whole history cost one API page. 80 activities (79 runs,
1 ride), all 80 linked by `(source='strava', external_id)`, none by time
match. 76 of them have elapsed > moving. `pnpm strava:times --report`
re-runs the reconciliation from stored rows with no API calls.

Reconciliation, local − Strava (`derived_moving` refreshed first with
`pnpm dm:backfill --write`, which the local DB was missing):

| Estimator | vs | n | bias | MAE | MAPE | ≤30 s |
|---|---|---|---|---|---|---|
| `computeMovingTime(moving)` | moving | 76 | −1 s | 89 s | 1.8% | 63% |
| `computeMovingTime(derived_moving)` | moving | 76 | −3 s | 90 s | 1.9% | 61% |
| `runs.duration_s` | moving | 79 | 0 s | 0 s | 0% | 100% |
| `runs.duration_s` | elapsed | 79 | −251 s | 251 s | 5.1% | 18% |
| stream span | elapsed | 76 | 0 s | 0 s | 0% | 100% |

Findings:

- **The in-house flag works as well as Strava's own flag.** Fed through
  `computeMovingTime`, `derived_moving` (speed < 1.0 m/s) and Strava's real
  per-sample `moving` land within 1 s MAE of each other. Both are essentially
  unbiased against Strava's aggregate (−1 s / −3 s mean). So the remaining
  ~90 s MAE comes from how `computeMovingTime` turns flags into a total, not
  from the flag. Every non-Strava run can keep relying on the derived flag.
- **Naive flag summing is much worse.** Summing dt over every
  `moving=true` sample, with no confirmed-stop gating, gives 310 s MAE and
  always comes in low. That backs up the 5 s `MIN_STOP_S` flicker gate.
- **Stream span = elapsed_time exactly.** The stream time axis is a
  lossless proxy for elapsed time.
- **`runs.duration_s` = Strava `moving_time`** for every Strava-sourced run.
  This is by construction (`mapper.ts` maps `duration_s: a.moving_time`), not
  an independent check. Consequence: `runs.duration_s` means *moving* time
  for Strava rows but device-reported time for other sources. Anything
  comparing durations across sources should keep that in mind.
- **One real gap bug (the +1942 s outlier, run A).** The stream has a
  1898 s recording gap (t 6474 → 8372) over which cumulative distance jumps
  ~2 km (a GPS/recording dropout). The sample right after the gap is a
  single `moving=false` sample, shorter than `MIN_STOP_S`, so it isn't a
  confirmed stop. The whole 1898 s dt is then counted as moving. Strava
  leaves it out. The other large misses run the other way (local 200–600 s
  *below* Strava, by up to ~600 s): Strava counts
  some flagged stops as moving. So there's no single rule to recalibrate
  against. `computeMovingTime` is left unchanged here; gap handling is a
  follow-up.

## 2026-09-26 — Recording gaps in confirmed-stop detection (MZY-217)

Follow-up to the MZY-40 finding above: run A's 1898 s
recording gap ended on a lone `moving=false` sample. `findConfirmedStops`
measured the stop from the first stopped sample to the first moving one,
which came to 1 s, so the gap was treated as flicker and counted as moving.

**Sampling data** (76 Strava streams, 286,763 intervals). The dt is 1 s
for 94.1% of intervals and 2 s for 4.8%, and every stream's median is 1 s.
Anything over 2 s is a 0.05% tail (136 intervals over 10 s). Almost every
long interval ends on a `moving=false` sample with about 0 m moved, which is
Strava auto-pausing while the athlete stands still. Only three end on a
`moving=true` sample, and each covers real distance. The biggest (run B) is
1243 s, 2641 m, 2.12 m/s. Strava's aggregate counts it as
moving and Agon already matched that.

**Rule chosen.** A stop's length is now the longer of two spans:
first stopped → first moving sample (the original rule), or the span the
stop actually freezes, timeS[stopStart−1] → timeS[resumeIdx−1], which
includes the dt leading into it. On evenly sampled data the two spans are
equal, so flicker gating is unchanged. Taking the longer span also means
no previously confirmed stop is lost. **Rejected:** "any dt far above the
normal interval counts as paused." A threshold anywhere in the 3–1000 s
tail would pause run B's 1243 s moving gap and add a −1243 s miss on
a run that currently matches.

`computeMovingTime` vs Strava `moving_time` (`pnpm strava:times --report`):

| Estimator | | n | bias | MAE | MAPE | ≤30 s |
|---|---|---|---|---|---|---|
| `computeMovingTime(moving)` | before | 76 | −1 s | 89 s | 1.8% | 63% |
| `computeMovingTime(moving)` | after | 76 | −43 s | 62 s | 1.3% | 63% |
| `computeMovingTime(derived_moving)` | before | 76 | −3 s | 90 s | 1.9% | 61% |
| `computeMovingTime(derived_moving)` | after | 76 | −19 s | 87 s | 1.8% | 63% |

- Run A (moving flag): +1942 s → +44 s.
- 15 other runs changed. 7 moved closer to Strava and 8 further away,
  because Strava's own total is inconsistent about auto-paused stops. It
  leaves some out and counts others as moving. This is the same behaviour behind the big negative misses. Not
  tuned against it.
- The −43 s bias isn't new error. About −25 s of it was always there and was
  hidden by the +1942 s outlier. The rest comes from newly frozen
  standing-still pauses.
- `derived_moving` still misses run A (+1940 s), and that's a flag problem,
  not a summing problem. Across the gap the derived speed is 1952 m ÷
  1898 s = 1.03 m/s, just over the 1.0 m/s threshold, so the post-gap
  sample is derived as moving. Follow-up: MZY-218.

Best efforts / Riegel (`pnpm be:backfill` / `pnpm rp:backfill`): 578 → 615
confirmed stops, and the recovery-window charge-back went from 2629.7 s to
2365.3 s.

Effect on best efforts: a few PRs got slightly faster because standing
pauses with 0 m moved are now frozen like any other confirmed stop, and the
Riegel exponent moved by a few thousandths.

- Run A's full distance drops by the ~2 km covered during the gap, which is
  dropped along with the gap's time, per `buildNetAdjustedStream`'s
  no-free-distance rule (unchanged).
- **Bucket tolerance (athlete decision).** Freezing a newly confirmed 9 s
  pause removed 3 m of GPS drift from a 5K-PR run, which went from 5002 m to
  4998 m and dropped out of the 5K bucket. `findBucketEffort`
  (`lib/bestEfforts.ts`) now accepts a stream up to 0.2% short
  (`BUCKET_SHORTFALL_TOLERANCE`, i.e. 4990 m for a 5K). When it does, the
  effort's time is scaled up to the full bucket distance at the run's own
  pace, so it never gets credit for metres it didn't cover.

## 2026-09-26 — Recording gaps in the derived moving flag (MZY-218) — documented, not fixed

Follow-up to MZY-217: `deriveMovingFlags` judges the sample after a
recording gap on the gap's average speed, and on run A that average
(1952 m ÷ 1898 s = 1.03 m/s) is just over the 1.0 m/s threshold, so
`computeMovingTime(derived_moving)` is still +1940 s there.

**Who this affects.** Nobody today. All 76 distance-bearing streams are
Strava and carry Strava's own `moving` flag. The 46 Google Health runs have
either an HR-only `fitbit` stream (26, no distance) or no stream (20), and
there are no file imports. So `derived_moving` currently feeds only the
`strava:times` comparison and the `dm:backfill` calibration. It isn't used
for any best effort, PR or prediction.

**Sampling data.** Strava: 1 s for 94.1% of intervals and 2 s for 4.8%, with
115 intervals over 10 s. Fitbit HR streams (no distance, shown for
comparison): 1 s for 99.9%, 17 over 10 s. There are no distance-bearing
non-Strava streams to measure, so a "long gap" threshold can't be grounded
for the population this flag exists for.

**The evidence at the gaps.** There are 115 gaps over 10 s on distance-bearing
streams. `derived_moving` agrees with Strava on 114. Only three cover more
than 50 m:

| Run | gap | distance | avg speed | Strava | derived | edges |
|---|---|---|---|---|---|---|
| A | 1898 s | 1952 m | 1.03 m/s | stopped | moving | walking 1.0–1.1 m/s before (both flags: moving), cadence 0 on both sides, HR held flat, recording ends 6 s later |
| B | 1243 s | 2641 m | 2.12 m/s | moving | moving | running 3.2–3.5 m/s before; GPS catch-up spikes (6–14 m/s) then ~2.5 m/s after; no HR or cadence |
| C | 332 s | 104 m | 0.31 m/s | stopped | stopped | — |

A smaller gap on run C (33 s, 36 m, **1.1 m/s**) is counted as moving by
Strava. So Strava counts a 1.1 m/s gap as moving and a 1.03 m/s gap as
stopped. On run A the gap average isn't misleading either: it matches the
walking pace right before the gap, which both flags count as moving. Strava's
"stopped" reflects its recorder being paused, and no stream carries that.
There is no HR or cadence *across* a gap. At the edges, run A's cadence was
already 0 in the stretch Strava counts as moving, and its HR is a held value.

**Options rejected.**
- Speed cutoff for gaps: tuned to two points, and run C's 1.1 m/s gap
  contradicts any cutoff that puts run A as stopped.
- Edge rules (post-gap speed, "catch-up spike ⇒ GPS loss ⇒ moving",
  cadence 0): each is fitted to one example per side. Stopping to press
  "stop" at the end of a run (run A's last samples) is normal and not
  evidence of a pause.
- Mark as unknown (null): `computeMovingTime` treats null as moving, so the
  number is unchanged. It would only move the documentation into the data.

**Decision.** `deriveMovingFlags` is unchanged. The limitation is documented
on the function and pinned by a unit test. Revisit once non-Strava
distance-bearing streams exist (Google Health TCX, file imports), since then
their own gap distribution can be measured. Numbers are unchanged from the
MZY-217 baseline: `strava:times` moving flag 62 s MAE / −43 s bias / 63%,
derived 87 s / −19 s / 63%. `dm:backfill` F1 at 1.0 m/s is 0.99 (recall
98.7%, precision 98.4%; it was 0.98 before MZY-217 changed confirmed-stop
detection). Best efforts and Riegel are unchanged.
