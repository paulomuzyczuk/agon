import {
  parseCyclingPowerMeasurement,
  computePowerWheelSpeedKmh,
} from '@/lib/bluetoothPower';
import { computeCadenceRpm } from '@/lib/bluetoothCycling';

// Hand-built Cycling Power Measurement (GATT 0x2A63) frames, MZY-270. No power
// meter exists yet, so the wire format is the spec's, byte by byte.

type Field =
  | { bit: 0; balanceRaw: number }
  | { bit: 2; torqueRaw: number }
  | { bit: 4; revs: number; time2048: number }
  | { bit: 5; revs: number; time1024: number }
  | { bit: 6 | 7 | 8 | 9 | 10 } // walked-over fields, filled with 0xAA
  | { bit: 11; kj: number };

const SIZE: Record<number, number> = {
  0: 1,
  2: 2,
  4: 6,
  5: 4,
  6: 4,
  7: 4,
  8: 3,
  9: 2,
  10: 2,
  11: 2,
};

/** flags + sint16 power + the given fields IN SPEC ORDER (+ extra flag bits). */
function frame(powerW: number, fields: Field[] = [], extraFlags = 0): DataView {
  const sorted = [...fields].sort((a, b) => a.bit - b.bit);
  const len = 4 + sorted.reduce((n, f) => n + SIZE[f.bit]!, 0);
  const v = new DataView(new ArrayBuffer(len));
  let flags = extraFlags;
  for (const f of sorted) flags |= 1 << f.bit;
  v.setUint16(0, flags, true);
  v.setInt16(2, powerW, true);
  let o = 4;
  for (const f of sorted) {
    if (f.bit === 0) v.setUint8(o, f.balanceRaw);
    else if (f.bit === 2) v.setUint16(o, f.torqueRaw, true);
    else if (f.bit === 4) {
      v.setUint32(o, f.revs, true);
      v.setUint16(o + 4, f.time2048, true);
    } else if (f.bit === 5) {
      v.setUint16(o, f.revs, true);
      v.setUint16(o + 2, f.time1024, true);
    } else if (f.bit === 11) v.setUint16(o, f.kj, true);
    else for (let i = 0; i < SIZE[f.bit]!; i++) v.setUint8(o + i, 0xaa);
    o += SIZE[f.bit]!;
  }
  return v;
}

/** The same bytes, cut to `n`. */
const truncate = (v: DataView, n: number) => new DataView(v.buffer.slice(0, n));

describe('parseCyclingPowerMeasurement', () => {
  it('reads power alone', () => {
    expect(parseCyclingPowerMeasurement(frame(287))).toEqual({
      instantaneousPowerW: 287,
      pedalBalancePct: null,
      balanceReferenceLeft: false,
      accumulatedTorqueNm: null,
      cumulativeWheelRevs: null,
      lastWheelEventTime2048: null,
      cumulativeCrankRevs: null,
      lastCrankEventTime1024: null,
      accumulatedEnergyKj: null,
    });
  });

  it('reads instantaneous power as SIGNED', () => {
    expect(parseCyclingPowerMeasurement(frame(-3))!.instantaneousPowerW).toBe(
      -3,
    );
  });

  it('reads balance in 1/2 % and the left-reference flag', () => {
    const m = parseCyclingPowerMeasurement(
      frame(200, [{ bit: 0, balanceRaw: 101 }], 1 << 1),
    )!;
    expect(m.pedalBalancePct).toBe(50.5);
    expect(m.balanceReferenceLeft).toBe(true);
  });

  it('reads accumulated torque in 1/32 Nm', () => {
    const m = parseCyclingPowerMeasurement(
      frame(200, [{ bit: 2, torqueRaw: 64 }]),
    )!;
    expect(m.accumulatedTorqueNm).toBe(2);
  });

  // Each optional field on its own, with accumulated energy (the LAST field)
  // as a sentinel: it only reads back correctly if the walk got the offset right.
  it.each([0, 2, 4, 5, 6, 7, 8, 9, 10] as const)(
    'walks past field bit %i to the right offset',
    (bit) => {
      const field = (
        bit === 0
          ? { bit, balanceRaw: 100 }
          : bit === 2
            ? { bit, torqueRaw: 32 }
            : bit === 4
              ? { bit, revs: 10, time2048: 2048 }
              : bit === 5
                ? { bit, revs: 5, time1024: 1024 }
                : { bit }
      ) as Field;
      const m = parseCyclingPowerMeasurement(
        frame(150, [field, { bit: 11, kj: 0xbeef }]),
      )!;
      expect(m.accumulatedEnergyKj).toBe(0xbeef);
      expect(m.instantaneousPowerW).toBe(150);
    },
  );

  it('reads every field at once, wheel in 1/2048 s and crank in 1/1024 s', () => {
    const m = parseCyclingPowerMeasurement(
      frame(312, [
        { bit: 0, balanceRaw: 96 },
        { bit: 2, torqueRaw: 320 },
        { bit: 4, revs: 123456, time2048: 40000 },
        { bit: 5, revs: 789, time1024: 30000 },
        { bit: 6 },
        { bit: 7 },
        { bit: 8 },
        { bit: 9 },
        { bit: 10 },
        { bit: 11, kj: 412 },
      ]),
    )!;
    expect(m).toEqual({
      instantaneousPowerW: 312,
      pedalBalancePct: 48,
      balanceReferenceLeft: false,
      accumulatedTorqueNm: 10,
      cumulativeWheelRevs: 123456,
      lastWheelEventTime2048: 40000,
      cumulativeCrankRevs: 789,
      lastCrankEventTime1024: 30000,
      accumulatedEnergyKj: 412,
    });
  });

  it('returns null (never throws) when cut short at any field boundary', () => {
    const full = frame(312, [
      { bit: 0, balanceRaw: 96 },
      { bit: 2, torqueRaw: 320 },
      { bit: 4, revs: 1, time2048: 1 },
      { bit: 5, revs: 1, time1024: 1 },
      { bit: 6 },
      { bit: 8 },
      { bit: 11, kj: 1 },
    ]);
    for (let n = 0; n < full.byteLength; n++) {
      expect(parseCyclingPowerMeasurement(truncate(full, n))).toBeNull();
    }
    expect(parseCyclingPowerMeasurement(full)).not.toBeNull();
  });
});

describe('power-meter crank + wheel data', () => {
  it('feeds computeCadenceRpm unchanged, across a uint16 rollover', () => {
    const a = parseCyclingPowerMeasurement(
      frame(250, [{ bit: 5, revs: 65535, time1024: 65000 }]),
    )!;
    const b = parseCyclingPowerMeasurement(
      frame(250, [{ bit: 5, revs: 0, time1024: 147 }]), // (65000 + 683) mod 65536
    )!;
    // 1 rev in 683/1024 s ≈ 0.667 s → 90 rpm
    const rpm = computeCadenceRpm(
      {
        cumulativeCrankRevs: a.cumulativeCrankRevs!,
        lastCrankEventTime1024: a.lastCrankEventTime1024!,
      },
      {
        cumulativeCrankRevs: b.cumulativeCrankRevs!,
        lastCrankEventTime1024: b.lastCrankEventTime1024!,
      },
    );
    expect(rpm).toBeCloseTo(89.96, 1);
  });

  it('computes wheel speed with the 1/2048 s time base', () => {
    // 10 revs of a 2105 mm wheel in 2048/2048 s = 21.05 m/s = 75.78 km/h.
    const kmh = computePowerWheelSpeedKmh(
      { cumulativeWheelRevs: 100, lastWheelEventTime2048: 1000 },
      { cumulativeWheelRevs: 110, lastWheelEventTime2048: 3048 },
      2105,
    );
    expect(kmh).toBeCloseTo(75.78, 2);
  });

  it('handles a wheel event-time rollover and a stationary wheel', () => {
    expect(
      computePowerWheelSpeedKmh(
        { cumulativeWheelRevs: 5, lastWheelEventTime2048: 65000 },
        { cumulativeWheelRevs: 6, lastWheelEventTime2048: 1512 }, // (65000 + 2048) mod 65536
        2000,
      ),
    ).toBeCloseTo(7.2, 6); // 2 m in 1 s
    expect(
      computePowerWheelSpeedKmh(
        { cumulativeWheelRevs: 5, lastWheelEventTime2048: 500 },
        { cumulativeWheelRevs: 5, lastWheelEventTime2048: 500 },
        2000,
      ),
    ).toBeNull();
  });
});
