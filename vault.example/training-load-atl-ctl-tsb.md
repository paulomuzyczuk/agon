---
title: Training load — ATL, CTL, TSB
tags: [training-load, periodization, recovery]
---

# Training load: ATL, CTL, TSB

A simple impulse–response way to track fitness and fatigue from a daily training
load score (e.g. TSS, or an HR-based session load).

- **CTL (Chronic Training Load)** — an exponentially-weighted average of daily
  load over a long window (~42 days). A proxy for **fitness**: it rises slowly
  and falls slowly.
- **ATL (Acute Training Load)** — the same idea over a short window (~7 days). A
  proxy for **fatigue**: it rises and falls quickly.
- **TSB (Training Stress Balance)** = CTL − ATL. A proxy for **form/freshness**.
  Positive TSB → fresh/tapered; strongly negative → fatigued and possibly
  overreaching.

## Practical reading

- Building fitness requires periods of negative TSB — you can't raise CTL without
  accumulating fatigue. The skill is dosing it.
- Very negative TSB sustained for weeks is an overreaching flag; pair it with
  subjective markers and [[hrv-and-recovery]] before pushing further.
- A race taper aims to bring TSB positive while giving up as little CTL as
  possible.

## Relevance to Agon

Computed in the `fct_training_load_daily` mart (see the dashboard-metrics plan).
Cross-reference with easy-run [[vo2max]] compliance and sleep/HRV to distinguish
productive overload from dug-in fatigue.
