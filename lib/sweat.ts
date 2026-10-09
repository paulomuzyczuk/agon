// Pure sweat-rate math for the /sweat command (CLAUDE.md Telegram Bot Commands +
// "Run fueling & hydration model"). Kept DB-free so it's shared + unit-testable.
//
// Total sweat loss over an effort = body-mass lost + fluid drunk during it:
//   lossL = (preKg − postKg) + fluidL         (1 kg body mass ≈ 1 L water)
// The rate divides that by the effort's duration in hours. Duration comes from
// the run the weigh-in is attributed to; when it's unknown the rate is null (the
// raw observation is still stored so a rate can be computed later).

export interface SweatRateInputs {
  preKg: number;
  postKg: number;
  fluidL: number;
  durationS: number | null;
}

/** Total sweat volume lost, in litres (never negative). */
export function sweatLossLitres(
  preKg: number,
  postKg: number,
  fluidL: number,
): number {
  return Math.max(0, preKg - postKg + fluidL);
}

/** Sweat rate in L/h, or null when no positive duration is available. */
export function sweatRateLPerH(inputs: SweatRateInputs): number | null {
  const { preKg, postKg, fluidL, durationS } = inputs;
  if (durationS == null || durationS <= 0) return null;
  const lossL = sweatLossLitres(preKg, postKg, fluidL);
  const rate = lossL / (durationS / 3600);
  return Math.round(rate * 1000) / 1000; // NUMERIC(5,3) in the DB
}
