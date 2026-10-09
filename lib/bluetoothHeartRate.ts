// Pure parser for the Bluetooth SIG "Heart Rate Measurement" characteristic
// (GATT spec 0x2A37), DB/DOM-free beyond the DataView type it reads. Used by
// app/heart-rate/page.tsx (Web Bluetooth PoC) to decode notifications from a
// paired HR strap (e.g. Garmin HRM 200) — no run/DB/network concerns here.
//
// Byte layout:
//   byte 0        flags
//     bit 0         HR value format: 0 = UInt8, 1 = UInt16 (both little-endian)
//     bit 1         sensor contact status (only meaningful if bit 2 is set)
//     bit 2         sensor contact feature supported
//     bit 3         energy expended present (UInt16, kJ)
//     bit 4         RR-interval(s) present (one or more UInt16, units of 1/1024 s)
//   next 1-2 bytes  HR value (per bit 0)
//   next 0/2 bytes  energy expended (per bit 3)
//   remaining bytes RR-intervals, UInt16 each, repeated to the end of the buffer

export type SensorContact = 'not-supported' | 'supported-detected' | 'supported-not-detected';

export interface HeartRateMeasurement {
  bpm: number;
  sensorContact: SensorContact;
  energyExpendedKJ?: number;
  rrIntervalsMs?: number[];
}

const FLAG_HR_FORMAT_UINT16 = 0x01;
const FLAG_SENSOR_CONTACT_DETECTED = 0x02;
const FLAG_SENSOR_CONTACT_SUPPORTED = 0x04;
const FLAG_ENERGY_EXPENDED_PRESENT = 0x08;
const FLAG_RR_INTERVALS_PRESENT = 0x10;

const RR_INTERVAL_UNIT_S = 1 / 1024;

/**
 * Decodes a Heart Rate Measurement notification payload. Returns `null`
 * (never throws) on a too-short or otherwise malformed buffer — a single bad
 * BLE frame must not crash the caller.
 */
export function parseHeartRateMeasurement(data: DataView): HeartRateMeasurement | null {
  if (data.byteLength < 2) return null;

  const flags = data.getUint8(0);
  let offset = 1;

  const isUint16Hr = (flags & FLAG_HR_FORMAT_UINT16) !== 0;
  const hrByteLength = isUint16Hr ? 2 : 1;
  if (data.byteLength < offset + hrByteLength) return null;

  const bpm = isUint16Hr ? data.getUint16(offset, true) : data.getUint8(offset);
  offset += hrByteLength;

  const sensorContactSupported = (flags & FLAG_SENSOR_CONTACT_SUPPORTED) !== 0;
  const sensorContact: SensorContact = !sensorContactSupported
    ? 'not-supported'
    : (flags & FLAG_SENSOR_CONTACT_DETECTED) !== 0
      ? 'supported-detected'
      : 'supported-not-detected';

  let energyExpendedKJ: number | undefined;
  if ((flags & FLAG_ENERGY_EXPENDED_PRESENT) !== 0) {
    if (data.byteLength < offset + 2) return null;
    energyExpendedKJ = data.getUint16(offset, true);
    offset += 2;
  }

  let rrIntervalsMs: number[] | undefined;
  if ((flags & FLAG_RR_INTERVALS_PRESENT) !== 0) {
    rrIntervalsMs = [];
    while (offset + 2 <= data.byteLength) {
      const rawUnits = data.getUint16(offset, true);
      rrIntervalsMs.push(rawUnits * RR_INTERVAL_UNIT_S * 1000);
      offset += 2;
    }
  }

  return { bpm, sensorContact, energyExpendedKJ, rrIntervalsMs };
}
