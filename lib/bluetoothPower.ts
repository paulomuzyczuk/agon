// Pure parser for the Bluetooth SIG "Cycling Power Measurement"
// characteristic (GATT 0x2A63) of the standard BLE Cycling Power service
// (0x1818), broadcast by power-meter pedals, cranks, hubs and smart trainers
// (MZY-270). Decoded the same DB/DOM-free way as lib/bluetoothCycling.ts (CSC)
// and lib/bluetoothHeartRate.ts. Every watt read here is DEVICE-measured — the
// live recorder labels it `watts_source = 'device'`.
//
// Byte layout (all little-endian):
//   bytes 0-1   uint16 flags
//   bytes 2-3   sint16 instantaneous power (W)
//   then, ONLY for each flag set, in this exact order:
//     bit 0   pedal power balance        uint8, 1/2 %  (bit 1 = reference is
//                                                       the LEFT pedal; no data)
//     bit 2   accumulated torque         uint16, 1/32 Nm (bit 3 = source; no data)
//     bit 4   wheel revolution data      uint32 cumulative revs +
//                                        uint16 last event time, 1/2048 s (!)
//     bit 5   crank revolution data      uint16 cumulative revs +
//                                        uint16 last event time, 1/1024 s
//     bit 6   extreme force magnitudes   sint16 max + sint16 min (N)
//     bit 7   extreme torque magnitudes  sint16 max + sint16 min (1/32 Nm)
//     bit 8   extreme angles             uint24: two packed 12-bit angles
//     bit 9   top dead spot angle        uint16 (deg)
//     bit 10  bottom dead spot angle     uint16 (deg)
//     bit 11  accumulated energy         uint16 (kJ)
//     bit 12  offset compensation indicator (no data)
//
// THE TRAP: the wheel event time here is in 1/2048 s, unlike CSC's 1/1024 s;
// the crank event time is 1/1024 s in both. Mixing them up doubles (or halves)
// wheel speed. Crank data is shaped exactly like CSC's so it feeds
// computeCadenceRpm unchanged — a power meter can stand in for the cadence
// sensor.

import { rolloverDelta } from './bluetoothCycling';

export interface CyclingPowerMeasurement {
  /** Instantaneous power (W). Signed on the wire; a negative value is a meter quirk. */
  instantaneousPowerW: number;
  /** Share of power from the reference pedal (%), or null when not reported. */
  pedalBalancePct: number | null;
  /** True when the balance reference is the left pedal (flag bit 1). */
  balanceReferenceLeft: boolean;
  /** Accumulated torque (Nm), wraps at 2048 Nm. */
  accumulatedTorqueNm: number | null;
  cumulativeWheelRevs: number | null;
  /** Raw uint16, units of 1/2048 s (NOT CSC's 1/1024), wraps at 65536. */
  lastWheelEventTime2048: number | null;
  /** Raw uint16, wraps at 65536 — same shape as CSC, feeds computeCadenceRpm. */
  cumulativeCrankRevs: number | null;
  /** Raw uint16, units of 1/1024 s, wraps at 65536. */
  lastCrankEventTime1024: number | null;
  /** Accumulated energy (kJ), wraps at 65536. */
  accumulatedEnergyKj: number | null;
}

const FLAG_BALANCE = 1 << 0;
const FLAG_BALANCE_REF_LEFT = 1 << 1;
const FLAG_ACC_TORQUE = 1 << 2;
const FLAG_WHEEL = 1 << 4;
const FLAG_CRANK = 1 << 5;
const FLAG_EXTREME_FORCE = 1 << 6;
const FLAG_EXTREME_TORQUE = 1 << 7;
const FLAG_EXTREME_ANGLES = 1 << 8;
const FLAG_TOP_DEAD_SPOT = 1 << 9;
const FLAG_BOTTOM_DEAD_SPOT = 1 << 10;
const FLAG_ACC_ENERGY = 1 << 11;

/**
 * Decodes a Cycling Power Measurement notification payload. Returns `null`
 * (never throws) on a buffer too short for the fields its own flags announce
 * — a single bad BLE frame must not crash the recorder.
 */
export function parseCyclingPowerMeasurement(
  data: DataView,
): CyclingPowerMeasurement | null {
  if (data.byteLength < 4) return null;
  const flags = data.getUint16(0, true);
  const has = (bit: number) => (flags & bit) !== 0;
  let offset = 4;
  /** Whether `n` more bytes exist at the cursor. */
  const fits = (n: number): boolean => data.byteLength >= offset + n;

  const out: CyclingPowerMeasurement = {
    instantaneousPowerW: data.getInt16(2, true),
    pedalBalancePct: null,
    balanceReferenceLeft: has(FLAG_BALANCE_REF_LEFT),
    accumulatedTorqueNm: null,
    cumulativeWheelRevs: null,
    lastWheelEventTime2048: null,
    cumulativeCrankRevs: null,
    lastCrankEventTime1024: null,
    accumulatedEnergyKj: null,
  };

  if (has(FLAG_BALANCE)) {
    if (!fits(1)) return null;
    out.pedalBalancePct = data.getUint8(offset) / 2;
    offset += 1;
  }
  if (has(FLAG_ACC_TORQUE)) {
    if (!fits(2)) return null;
    out.accumulatedTorqueNm = data.getUint16(offset, true) / 32;
    offset += 2;
  }
  if (has(FLAG_WHEEL)) {
    if (!fits(6)) return null;
    out.cumulativeWheelRevs = data.getUint32(offset, true);
    out.lastWheelEventTime2048 = data.getUint16(offset + 4, true);
    offset += 6;
  }
  if (has(FLAG_CRANK)) {
    if (!fits(4)) return null;
    out.cumulativeCrankRevs = data.getUint16(offset, true);
    out.lastCrankEventTime1024 = data.getUint16(offset + 2, true);
    offset += 4;
  }
  // Walked for their length only — Agon doesn't use them (yet).
  for (const [bit, size] of [
    [FLAG_EXTREME_FORCE, 4],
    [FLAG_EXTREME_TORQUE, 4],
    [FLAG_EXTREME_ANGLES, 3],
    [FLAG_TOP_DEAD_SPOT, 2],
    [FLAG_BOTTOM_DEAD_SPOT, 2],
  ] as const) {
    if (!has(bit)) continue;
    if (!fits(size)) return null;
    offset += size;
  }
  if (has(FLAG_ACC_ENERGY)) {
    if (!fits(2)) return null;
    out.accumulatedEnergyKj = data.getUint16(offset, true);
    offset += 2;
  }
  return out;
}

const WHEEL_EVENT_TIME_UNIT_S = 1 / 2048;
const UINT16_ROLLOVER = 65536;
const UINT32_ROLLOVER = 4294967296;

/**
 * Instantaneous speed (km/h) between two consecutive power-meter wheel
 * readings from the SAME connection — the 1/2048 s counterpart of
 * lib/bluetoothCycling.ts computeWheelSpeedKmh. Null when no new wheel
 * event arrived since `prev` (wheel stationary).
 */
export function computePowerWheelSpeedKmh(
  prev: { cumulativeWheelRevs: number; lastWheelEventTime2048: number },
  curr: { cumulativeWheelRevs: number; lastWheelEventTime2048: number },
  wheelCircumferenceMm: number,
): number | null {
  const dTime = rolloverDelta(
    curr.lastWheelEventTime2048,
    prev.lastWheelEventTime2048,
    UINT16_ROLLOVER,
  );
  if (dTime === 0) return null;
  const dRevs = rolloverDelta(
    curr.cumulativeWheelRevs,
    prev.cumulativeWheelRevs,
    UINT32_ROLLOVER,
  );
  const distanceM = dRevs * (wheelCircumferenceMm / 1000);
  return (distanceM / (dTime * WHEEL_EVENT_TIME_UNIT_S)) * 3.6;
}
