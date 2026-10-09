import { insertBodyMetric } from '../bodyMetrics';
import type { BodyParse } from './schemas';

// Fan a parsed body note out into body_metrics. Skips the write entirely when
// neither weight nor body-fat was captured — an empty measurement row is noise.

export interface BodyFanOutResult {
  bodyMetricId: string | null;
}

export async function fanOutBody(
  parse: BodyParse,
  effectiveDate: string,
): Promise<BodyFanOutResult> {
  if (parse.weight_kg == null && parse.body_fat_pct == null) {
    return { bodyMetricId: null };
  }
  const id = await insertBodyMetric({
    date: effectiveDate,
    weightKg: parse.weight_kg,
    bodyFatPct: parse.body_fat_pct,
    notes: parse.notes,
  });
  return { bodyMetricId: id };
}
