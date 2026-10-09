import { athleteLocalParts } from '../../lib/time';
import { getAthleteProfile } from '../../lib/athleteProfile';
import type { SourcedBodyMetricRecord } from '../bodyMetrics';
import type { WellnessDataPoint } from './types';
import {
  valueObject,
  wellnessExternalId,
  readNumber,
  structuredDateToISO,
} from './wellnessMap';

// Pure mapping for the Google Health body-composition pass (MZY-216): `weight`
// and `body-fat` sample points → body_metrics rows. No I/O.
//
// `weight` VERIFIED LIVE 2026-09-25 against the athlete's account: each point
// carries `weight.sampleTime` = { physicalTime (RFC-3339), utcOffset,
// civilTime: { date: {year,month,day}, time } } and `weight.weightGrams`
// (number). Sources seen: MANUAL/FITBIT (Fitbit app) and HEALTH_CONNECT
// (fi.polar.polarflow). `body-fat` returned 0 points, so its value field is
// TODO(live) — assumed to mirror weight's sampleTime with a percentage field;
// reads try several candidates and degrade to null, never throw.

const TZ = getAthleteProfile().timeZone;

export const BODY_DATA_TYPES = ['weight', 'body-fat'] as const;
export type BodyDataType = (typeof BODY_DATA_TYPES)[number];

interface SampleTime {
  physicalTime: string | null;
  localDate: string | null;
}

/** Read a sample point's instant + athlete-local calendar day. */
function readSampleTime(obj: Record<string, unknown> | null): SampleTime {
  const st =
    obj?.sampleTime && typeof obj.sampleTime === 'object'
      ? (obj.sampleTime as Record<string, unknown>)
      : null;
  const physicalTime =
    typeof st?.physicalTime === 'string' ? st.physicalTime : null;
  // civilTime.date is the wall-clock day as recorded — already local.
  const civil =
    st?.civilTime && typeof st.civilTime === 'object'
      ? (st.civilTime as Record<string, unknown>)
      : null;
  let localDate = structuredDateToISO(civil?.date);
  if (!localDate && physicalTime) {
    try {
      localDate = athleteLocalParts(physicalTime, TZ).date;
    } catch {
      localDate = null;
    }
  }
  return { physicalTime, localDate };
}

const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** A mapped body point plus its instant (used only for mirror dedupe). */
export interface MappedBodyPoint {
  record: SourcedBodyMetricRecord;
  physicalTime: string | null;
}

/**
 * Map one `weight` or `body-fat` point to a body_metrics row, or null when it
 * has no id, no resolvable day, or no plausible value.
 */
export function mapBodyPoint(
  dp: WellnessDataPoint,
  dataType: BodyDataType,
): MappedBodyPoint | null {
  const externalId = wellnessExternalId(dp);
  if (!externalId) return null;
  const obj = valueObject(dp, dataType);
  const { physicalTime, localDate } = readSampleTime(obj);
  if (!localDate) return null;

  let weightKg: number | null = null;
  let bodyFatPct: number | null = null;
  if (dataType === 'weight') {
    const grams = readNumber(obj, ['weightGrams']);
    const kg = grams != null ? grams / 1000 : readNumber(obj, ['weightKg']);
    if (kg == null || kg <= 0) return null;
    weightKg = round(kg, 2);
  } else {
    const pct = readNumber(obj, ['percentage', 'bodyFatPercentage', 'percent']);
    if (pct == null || pct <= 0 || pct >= 100) return null;
    bodyFatPct = round(pct, 1);
  }

  return {
    record: {
      date: localDate,
      source: 'google_health',
      // Prefix with the dataType: ids are only unique within one dataType.
      externalId: `${dataType}:${externalId}`,
      weightKg,
      bodyFatPct,
    },
    physicalTime,
  };
}

/**
 * Drop mirrored duplicates: Health Connect re-publishes the same weigh-in
 * (e.g. Polar Flow → Fitbit), which arrives as a second point with the same
 * local day and value but a different id (seen live: two
 * identical-value points on the same day). For each (day, value) keep the
 * EARLIEST instant, so the kept row is stable across re-syncs. Genuinely
 * different same-day weigh-ins (different values) are all kept.
 */
export function dedupeMirroredBodyPoints(
  points: MappedBodyPoint[],
): SourcedBodyMetricRecord[] {
  const byKey = new Map<string, MappedBodyPoint>();
  for (const p of points) {
    const r = p.record;
    const key = `${r.date}|${r.weightKg ?? ''}|${r.bodyFatPct ?? ''}`;
    const kept = byKey.get(key);
    if (!kept || earlier(p, kept)) byKey.set(key, p);
  }
  return [...byKey.values()]
    .map((p) => p.record)
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.externalId.localeCompare(b.externalId),
    );
}

/** a before b by instant; ties (or missing instants) broken by external id. */
function earlier(a: MappedBodyPoint, b: MappedBodyPoint): boolean {
  const ta = a.physicalTime ? Date.parse(a.physicalTime) : NaN;
  const tb = b.physicalTime ? Date.parse(b.physicalTime) : NaN;
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta < tb;
  return a.record.externalId < b.record.externalId;
}
