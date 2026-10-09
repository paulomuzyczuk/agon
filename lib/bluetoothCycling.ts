// Pure parser for the Bluetooth SIG "CSC Measurement" characteristic (GATT spec
// 0x2A5B) broadcast by the standard BLE Cycling Speed and Cadence service
// (0x1816) — decoded the same DB/DOM-free way as lib/bluetoothHeartRate.ts.
// Used by app/record to read notifications from the Garmin Speed Sensor 2 and
// Cadence Sensor 2 (MZY-168): two SEPARATE physical devices that each
// broadcast this one service, one wheel-revolution-only, one
// crank-revolution-only — the Measurement's own presence flags tell us which
// is which per connection, no device-name sniffing needed.
//
// Byte layout:
//   byte 0        flags
//     bit 0         wheel revolution data present (6 bytes follow: uint32
//                    cumulative wheel revs, uint16 last wheel event time,
//                    units of 1/1024 s, little-endian)
//     bit 1         crank revolution data present (4 bytes follow: uint16
//                    cumulative crank revs, uint16 last crank event time,
//                    units of 1/1024 s, little-endian)
//
// A stationary sensor still notifies at a steady rate with an UNCHANGED event
// time (not silence) — every delta computation below treats a zero elapsed
// time as "no new sample" rather than a division by zero.

export interface CscMeasurement {
  cumulativeWheelRevs: number | null;
  lastWheelEventTime1024: number | null; // raw uint16, units of 1/1024s, wraps at 65536
  cumulativeCrankRevs: number | null; // raw uint16, wraps at 65536
  lastCrankEventTime1024: number | null; // raw uint16, units of 1/1024s, wraps at 65536
}

const FLAG_WHEEL_PRESENT = 0x01;
const FLAG_CRANK_PRESENT = 0x02;

const EVENT_TIME_UNIT_S = 1 / 1024;
const UINT16_ROLLOVER = 65536;
const UINT32_ROLLOVER = 4294967296;

/**
 * Decodes a CSC Measurement notification payload. Returns `null` (never
 * throws) on a too-short or otherwise malformed buffer — a single bad BLE
 * frame must not crash the caller.
 */
export function parseCscMeasurement(data: DataView): CscMeasurement | null {
  if (data.byteLength < 1) return null;

  const flags = data.getUint8(0);
  let offset = 1;

  let cumulativeWheelRevs: number | null = null;
  let lastWheelEventTime1024: number | null = null;
  if ((flags & FLAG_WHEEL_PRESENT) !== 0) {
    if (data.byteLength < offset + 6) return null;
    cumulativeWheelRevs = data.getUint32(offset, true);
    lastWheelEventTime1024 = data.getUint16(offset + 4, true);
    offset += 6;
  }

  let cumulativeCrankRevs: number | null = null;
  let lastCrankEventTime1024: number | null = null;
  if ((flags & FLAG_CRANK_PRESENT) !== 0) {
    if (data.byteLength < offset + 4) return null;
    cumulativeCrankRevs = data.getUint16(offset, true);
    lastCrankEventTime1024 = data.getUint16(offset + 2, true);
    offset += 4;
  }

  return {
    cumulativeWheelRevs,
    lastWheelEventTime1024,
    cumulativeCrankRevs,
    lastCrankEventTime1024,
  };
}

/** Forward distance between two counters that wrap at `rollover`. */
export function rolloverDelta(curr: number, prev: number, rollover: number): number {
  return curr >= prev ? curr - prev : curr + rollover - prev;
}

/**
 * Instantaneous speed (km/h) between two consecutive wheel readings from the
 * SAME connection, or `null` when there's no new wheel event since `prev`
 * (sensor stationary). `wheelCircumferenceMm` is the bike's own spec (see
 * lib/gear.ts GearSpec.wheelCircumferenceMm) — the CSC service reports raw
 * revolution counts, not distance, on purpose (it doesn't know the wheel).
 */
export function computeWheelSpeedKmh(
  prev: { cumulativeWheelRevs: number; lastWheelEventTime1024: number },
  curr: { cumulativeWheelRevs: number; lastWheelEventTime1024: number },
  wheelCircumferenceMm: number,
): number | null {
  const dTime1024 = rolloverDelta(
    curr.lastWheelEventTime1024,
    prev.lastWheelEventTime1024,
    UINT16_ROLLOVER,
  );
  if (dTime1024 === 0) return null;

  const dRevs = rolloverDelta(
    curr.cumulativeWheelRevs,
    prev.cumulativeWheelRevs,
    UINT32_ROLLOVER,
  );
  const dTimeS = dTime1024 * EVENT_TIME_UNIT_S;
  const distanceM = dRevs * (wheelCircumferenceMm / 1000);
  return (distanceM / dTimeS) * 3.6;
}

/**
 * Instantaneous cadence (rpm) between two consecutive crank readings from the
 * SAME connection, or `null` when there's no new crank event since `prev`.
 */
export function computeCadenceRpm(
  prev: { cumulativeCrankRevs: number; lastCrankEventTime1024: number },
  curr: { cumulativeCrankRevs: number; lastCrankEventTime1024: number },
): number | null {
  const dTime1024 = rolloverDelta(
    curr.lastCrankEventTime1024,
    prev.lastCrankEventTime1024,
    UINT16_ROLLOVER,
  );
  if (dTime1024 === 0) return null;

  const dRevs = rolloverDelta(
    curr.cumulativeCrankRevs,
    prev.cumulativeCrankRevs,
    UINT16_ROLLOVER,
  );
  const dTimeMin = (dTime1024 * EVENT_TIME_UNIT_S) / 60;
  return dRevs / dTimeMin;
}
