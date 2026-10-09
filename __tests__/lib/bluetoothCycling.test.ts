import {
  parseCscMeasurement,
  computeWheelSpeedKmh,
  computeCadenceRpm,
} from '@/lib/bluetoothCycling';

// Builds a CSC Measurement (GATT 0x2A5B) payload by hand: flags byte +
// optional wheel block (uint32 revs + uint16 event time) + optional crank
// block (uint16 revs + uint16 event time), matching the wire format.
function buildPayload(opts: {
  wheel?: { revs: number; eventTime1024: number };
  crank?: { revs: number; eventTime1024: number };
}): DataView {
  const wheelBytes = opts.wheel ? 6 : 0;
  const crankBytes = opts.crank ? 4 : 0;
  const buffer = new ArrayBuffer(1 + wheelBytes + crankBytes);
  const view = new DataView(buffer);

  let flags = 0;
  if (opts.wheel) flags |= 0x01;
  if (opts.crank) flags |= 0x02;

  let offset = 0;
  view.setUint8(offset, flags);
  offset += 1;

  if (opts.wheel) {
    view.setUint32(offset, opts.wheel.revs, true);
    view.setUint16(offset + 4, opts.wheel.eventTime1024, true);
    offset += 6;
  }

  if (opts.crank) {
    view.setUint16(offset, opts.crank.revs, true);
    view.setUint16(offset + 2, opts.crank.eventTime1024, true);
    offset += 4;
  }

  return view;
}

describe('parseCscMeasurement', () => {
  it('decodes a wheel-only frame (Speed Sensor 2)', () => {
    const view = buildPayload({ wheel: { revs: 1000, eventTime1024: 5000 } });
    expect(parseCscMeasurement(view)).toEqual({
      cumulativeWheelRevs: 1000,
      lastWheelEventTime1024: 5000,
      cumulativeCrankRevs: null,
      lastCrankEventTime1024: null,
    });
  });

  it('decodes a crank-only frame (Cadence Sensor 2)', () => {
    const view = buildPayload({ crank: { revs: 200, eventTime1024: 3000 } });
    expect(parseCscMeasurement(view)).toEqual({
      cumulativeWheelRevs: null,
      lastWheelEventTime1024: null,
      cumulativeCrankRevs: 200,
      lastCrankEventTime1024: 3000,
    });
  });

  it('decodes a combined wheel+crank frame', () => {
    const view = buildPayload({
      wheel: { revs: 1000, eventTime1024: 5000 },
      crank: { revs: 200, eventTime1024: 3000 },
    });
    expect(parseCscMeasurement(view)).toEqual({
      cumulativeWheelRevs: 1000,
      lastWheelEventTime1024: 5000,
      cumulativeCrankRevs: 200,
      lastCrankEventTime1024: 3000,
    });
  });

  it('returns null for an empty buffer instead of throwing', () => {
    expect(parseCscMeasurement(new DataView(new ArrayBuffer(0)))).toBeNull();
  });

  it('returns null when a declared wheel block is truncated', () => {
    const truncated = new DataView(new ArrayBuffer(3));
    truncated.setUint8(0, 0x01);
    expect(parseCscMeasurement(truncated)).toBeNull();
  });

  it('returns null when a declared crank block is truncated', () => {
    const truncated = new DataView(new ArrayBuffer(2));
    truncated.setUint8(0, 0x02);
    expect(parseCscMeasurement(truncated)).toBeNull();
  });
});

describe('computeWheelSpeedKmh', () => {
  const wheelCircumferenceMm = 2242; // Merida Silex 400 (MZY-168)

  it('computes speed from wheel-rev delta over elapsed time', () => {
    // 1 rev/s at 2242mm circumference -> 2.242 m/s -> 8.0712 km/h
    const prev = { cumulativeWheelRevs: 0, lastWheelEventTime1024: 0 };
    const curr = { cumulativeWheelRevs: 1, lastWheelEventTime1024: 1024 };
    expect(computeWheelSpeedKmh(prev, curr, wheelCircumferenceMm)).toBeCloseTo(
      8.0712,
      3,
    );
  });

  it('returns null when the event time has not advanced (sensor stationary)', () => {
    const prev = { cumulativeWheelRevs: 10, lastWheelEventTime1024: 500 };
    const curr = { cumulativeWheelRevs: 10, lastWheelEventTime1024: 500 };
    expect(computeWheelSpeedKmh(prev, curr, wheelCircumferenceMm)).toBeNull();
  });

  it('handles the uint16 event-time rollover (wraps at 65536)', () => {
    const prev = { cumulativeWheelRevs: 100, lastWheelEventTime1024: 65500 };
    const curr = { cumulativeWheelRevs: 101, lastWheelEventTime1024: 500 };
    // dTime1024 = (65536 - 65500) + 500 = 536 units ~= 0.5234s for 1 rev
    const speed = computeWheelSpeedKmh(prev, curr, wheelCircumferenceMm);
    expect(speed).not.toBeNull();
    expect(speed!).toBeCloseTo((2.242 / (536 / 1024)) * 3.6, 2);
  });

  it('handles the uint32 wheel-rev rollover', () => {
    const prev = { cumulativeWheelRevs: 4294967295, lastWheelEventTime1024: 0 };
    const curr = { cumulativeWheelRevs: 0, lastWheelEventTime1024: 1024 };
    // dRevs = (4294967296 - 4294967295) + 0 = 1 rev in 1s
    expect(computeWheelSpeedKmh(prev, curr, wheelCircumferenceMm)).toBeCloseTo(
      8.0712,
      3,
    );
  });
});

describe('computeCadenceRpm', () => {
  it('computes rpm from crank-rev delta over elapsed time', () => {
    // 1.5 revs in 1s -> 90 rpm
    const prev = { cumulativeCrankRevs: 0, lastCrankEventTime1024: 0 };
    const curr = { cumulativeCrankRevs: 3, lastCrankEventTime1024: 2048 };
    expect(computeCadenceRpm(prev, curr)).toBeCloseTo(90, 5);
  });

  it('returns null when the event time has not advanced (sensor stationary)', () => {
    const prev = { cumulativeCrankRevs: 5, lastCrankEventTime1024: 200 };
    const curr = { cumulativeCrankRevs: 5, lastCrankEventTime1024: 200 };
    expect(computeCadenceRpm(prev, curr)).toBeNull();
  });

  it('handles the uint16 crank-rev rollover', () => {
    const prev = { cumulativeCrankRevs: 65535, lastCrankEventTime1024: 0 };
    const curr = { cumulativeCrankRevs: 0, lastCrankEventTime1024: 1024 };
    // dRevs = (65536 - 65535) + 0 = 1 rev in 1s -> 60rpm
    expect(computeCadenceRpm(prev, curr)).toBeCloseTo(60, 5);
  });
});
