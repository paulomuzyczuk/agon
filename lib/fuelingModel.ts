// Pure fueling & hydration model (Premium-Parity #5), shared by runs AND rides
// (MZY-64). DB-free so it's unit-testable; services/fuelingBalance.ts loads the
// inputs and persists the result into run_fueling_balance / ride_fueling_balance.
//
// Deliberately NOT pace-based: pace→sweat doesn't transfer from running to
// cycling (same reason ride_relative_effort has no pace tier), so both
// activities key sweat loss off duration × HR intensity, the one signal they
// share. Sweat production tracks metabolic heat production, which scales with
// %VO2 reserve ≈ %HR reserve (Swain & Leutholtz 1997), so the intensity factor
// is HRr relative to the HRr the baseline was measured at.
//
//   est. sweat rate  = baseline × intensity × heat × humidity   (L/h)
//   est. sweat loss  = rate × hours                             (L ≈ kg)
//   body-mass loss % = (loss − fluid drunk) / body mass × 100   → >2% flag
//   sodium loss      = sweat loss × sweat sodium concentration
//   carbs/h target   = <1 h none · 1–2.5 h 30–60 g/h · >2.5 h 60–90 g/h
//                      (Jeukendrup 2014; ACSM 2016 position stand)
//
// The heat/humidity coefficients are conservative heuristics, not a fitted
// model — /sweat weigh-ins recalibrate the baseline itself, which dominates.

export type FuelingActivity = 'run' | 'ride';

/** HRr the baseline sweat rate is assumed measured at (easy/Z2 run ≈ 65% HRR). */
export const REFERENCE_HRR = 0.65;
/** Clamp on the intensity factor — beyond this HRr extrapolation isn't credible. */
const INTENSITY_FACTOR_MIN = 0.5;
const INTENSITY_FACTOR_MAX = 1.5;
/** +2% sweat rate per °C above 20 °C (−2% below), clamped. */
const HEAT_REF_C = 20;
const HEAT_PER_C = 0.02;
const HEAT_FACTOR_MIN = 0.7;
const HEAT_FACTOR_MAX = 1.5;
/** Humid air blunts evaporation → more dripping sweat: +0.3% per RH point above 50%. */
const HUMIDITY_REF_PCT = 50;
const HUMIDITY_PER_PCT = 0.003;
const HUMIDITY_FACTOR_MIN = 0.9;
const HUMIDITY_FACTOR_MAX = 1.15;

/** Body-mass loss above this % is the dehydration flag (ACSM). */
export const DEHYDRATION_THRESHOLD_PCT = 2;

export interface FuelingIntake {
  waterMl: number;
  carbsG: number;
  sodiumMg: number;
}

export interface FuelingModelInputs {
  durationS: number;
  avgHr: number | null;
  hrRest: number;
  hrMax: number;
  tempC: number | null;
  humidityPct: number | null;
  baselineSweatRateLPerH: number;
  sweatSodiumMgPerL: number;
  bodyMassKg: number;
  /** Summed intake; null when nothing was logged (unknown ≠ zero). */
  intake: FuelingIntake | null;
}

export interface CarbTarget {
  minGPerH: number;
  maxGPerH: number;
}

export interface FuelingBalance {
  intensityMethod: 'hr' | 'assumed';
  intensityFactor: number;
  heatFactor: number;
  estSweatRateLPerH: number;
  estSweatLossL: number;
  estSodiumLossMg: number;
  carbTarget: CarbTarget;
  intakeLogged: boolean;
  fluidIntakeL: number | null;
  netFluidL: number | null;
  bodyMassLossPct: number | null;
  sodiumIntakeMg: number | null;
  netSodiumMg: number | null;
  carbsG: number | null;
  carbsPerH: number | null;
  /** null when intake wasn't logged — can't tell "didn't drink" from "didn't log". */
  dehydrated: boolean | null;
  underFueled: boolean | null;
}

const round = (x: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};
const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/** Carbohydrate intake guideline for a session of this length. */
export function carbTargetForDuration(durationS: number): CarbTarget {
  const hours = durationS / 3600;
  if (hours < 1) return { minGPerH: 0, maxGPerH: 30 };
  if (hours <= 2.5) return { minGPerH: 30, maxGPerH: 60 };
  return { minGPerH: 60, maxGPerH: 90 };
}

/**
 * Sweat-rate multiplier from average HR. Null HR (or degenerate anchors) →
 * factor 1, i.e. assume the effort matched the baseline's.
 */
export function intensityFactor(
  avgHr: number | null,
  hrRest: number,
  hrMax: number,
): { factor: number; method: 'hr' | 'assumed' } {
  if (avgHr == null || hrMax <= hrRest) return { factor: 1, method: 'assumed' };
  const hrr = clamp((avgHr - hrRest) / (hrMax - hrRest), 0, 1);
  return {
    factor: clamp(
      hrr / REFERENCE_HRR,
      INTENSITY_FACTOR_MIN,
      INTENSITY_FACTOR_MAX,
    ),
    method: 'hr',
  };
}

/** Combined temperature × humidity multiplier; missing weather → neutral. */
export function heatFactor(
  tempC: number | null,
  humidityPct: number | null,
): number {
  const t =
    tempC == null
      ? 1
      : clamp(
          1 + HEAT_PER_C * (tempC - HEAT_REF_C),
          HEAT_FACTOR_MIN,
          HEAT_FACTOR_MAX,
        );
  const h =
    humidityPct == null
      ? 1
      : clamp(
          1 + HUMIDITY_PER_PCT * (humidityPct - HUMIDITY_REF_PCT),
          HUMIDITY_FACTOR_MIN,
          HUMIDITY_FACTOR_MAX,
        );
  return t * h;
}

export function computeFuelingBalance(i: FuelingModelInputs): FuelingBalance {
  const hours = i.durationS / 3600;
  const intensity = intensityFactor(i.avgHr, i.hrRest, i.hrMax);
  const heat = heatFactor(i.tempC, i.humidityPct);
  const rate = i.baselineSweatRateLPerH * intensity.factor * heat;
  const loss = rate * hours;
  const sodiumLoss = loss * i.sweatSodiumMgPerL;
  const carbTarget = carbTargetForDuration(i.durationS);

  const base = {
    intensityMethod: intensity.method,
    intensityFactor: round(intensity.factor, 3),
    heatFactor: round(heat, 3),
    estSweatRateLPerH: round(rate, 3),
    estSweatLossL: round(loss, 3),
    estSodiumLossMg: round(sodiumLoss, 0),
    carbTarget,
  };

  if (!i.intake) {
    return {
      ...base,
      intakeLogged: false,
      fluidIntakeL: null,
      netFluidL: null,
      bodyMassLossPct: null,
      sodiumIntakeMg: null,
      netSodiumMg: null,
      carbsG: null,
      carbsPerH: null,
      dehydrated: null,
      underFueled: null,
    };
  }

  const fluidL = i.intake.waterMl / 1000;
  const netFluid = fluidL - loss;
  const massLossPct = (Math.max(0, -netFluid) / i.bodyMassKg) * 100;
  const carbsPerH = hours > 0 ? i.intake.carbsG / hours : 0;
  return {
    ...base,
    intakeLogged: true,
    fluidIntakeL: round(fluidL, 3),
    netFluidL: round(netFluid, 3),
    bodyMassLossPct: round(massLossPct, 2),
    sodiumIntakeMg: round(i.intake.sodiumMg, 0),
    netSodiumMg: round(i.intake.sodiumMg - sodiumLoss, 0),
    carbsG: round(i.intake.carbsG, 1),
    carbsPerH: round(carbsPerH, 1),
    dehydrated: massLossPct > DEHYDRATION_THRESHOLD_PCT,
    underFueled: carbsPerH < carbTarget.minGPerH,
  };
}
