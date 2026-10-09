import { parseHeartRateMeasurement } from '@/lib/bluetoothHeartRate';

// Builds a Heart Rate Measurement (GATT 0x2A37) payload by hand: flags byte +
// HR value (per format bit) + optional energy-expended + optional RR-intervals.
function buildPayload(opts: {
  flags: number;
  hr: number;
  hrUint16?: boolean;
  energyExpendedKJ?: number;
  rrIntervalUnits?: number[]; // raw 1/1024s units, as transmitted on the wire
}): DataView {
  const hrBytes = opts.hrUint16 ? 2 : 1;
  const energyBytes = opts.energyExpendedKJ !== undefined ? 2 : 0;
  const rrBytes = (opts.rrIntervalUnits?.length ?? 0) * 2;
  const buffer = new ArrayBuffer(1 + hrBytes + energyBytes + rrBytes);
  const view = new DataView(buffer);

  let offset = 0;
  view.setUint8(offset, opts.flags);
  offset += 1;

  if (opts.hrUint16) {
    view.setUint16(offset, opts.hr, true);
    offset += 2;
  } else {
    view.setUint8(offset, opts.hr);
    offset += 1;
  }

  if (opts.energyExpendedKJ !== undefined) {
    view.setUint16(offset, opts.energyExpendedKJ, true);
    offset += 2;
  }

  for (const units of opts.rrIntervalUnits ?? []) {
    view.setUint16(offset, units, true);
    offset += 2;
  }

  return view;
}

describe('parseHeartRateMeasurement', () => {
  it('decodes an 8-bit HR value with no optional fields', () => {
    const view = buildPayload({ flags: 0x00, hr: 72 });
    expect(parseHeartRateMeasurement(view)).toEqual({
      bpm: 72,
      sensorContact: 'not-supported',
      energyExpendedKJ: undefined,
      rrIntervalsMs: undefined,
    });
  });

  it('decodes a 16-bit HR value (little-endian, value > 255)', () => {
    const view = buildPayload({ flags: 0x01, hr: 300, hrUint16: true });
    const result = parseHeartRateMeasurement(view);
    expect(result?.bpm).toBe(300);
  });

  it('reports sensor contact supported + detected', () => {
    const flags = 0x00 | 0x02 /* detected */ | 0x04 /* supported */;
    const view = buildPayload({ flags, hr: 65 });
    expect(parseHeartRateMeasurement(view)?.sensorContact).toBe('supported-detected');
  });

  it('reports sensor contact supported + not detected', () => {
    const flags = 0x00 | 0x04 /* supported, bit1 clear */;
    const view = buildPayload({ flags, hr: 65 });
    expect(parseHeartRateMeasurement(view)?.sensorContact).toBe('supported-not-detected');
  });

  it('parses energy expended without corrupting the HR reading', () => {
    const view = buildPayload({ flags: 0x08, hr: 80, energyExpendedKJ: 1234 });
    const result = parseHeartRateMeasurement(view);
    expect(result?.bpm).toBe(80);
    expect(result?.energyExpendedKJ).toBe(1234);
  });

  it('parses a single RR-interval, converting 1/1024s units to ms', () => {
    const view = buildPayload({ flags: 0x10, hr: 60, rrIntervalUnits: [1024] });
    const result = parseHeartRateMeasurement(view);
    expect(result?.rrIntervalsMs).toEqual([1000]);
  });

  it('parses multiple RR-intervals', () => {
    const view = buildPayload({ flags: 0x10, hr: 60, rrIntervalUnits: [512, 1024, 768] });
    const result = parseHeartRateMeasurement(view);
    expect(result?.rrIntervalsMs).toEqual([500, 1000, 750]);
  });

  it('parses a full combination: 16-bit HR + contact + energy + RR intervals', () => {
    const flags = 0x01 | 0x02 | 0x04 | 0x08 | 0x10;
    const view = buildPayload({
      flags,
      hr: 288,
      hrUint16: true,
      energyExpendedKJ: 500,
      rrIntervalUnits: [1024, 1024],
    });
    expect(parseHeartRateMeasurement(view)).toEqual({
      bpm: 288,
      sensorContact: 'supported-detected',
      energyExpendedKJ: 500,
      rrIntervalsMs: [1000, 1000],
    });
  });

  it('returns null for an empty or too-short buffer instead of throwing', () => {
    expect(parseHeartRateMeasurement(new DataView(new ArrayBuffer(0)))).toBeNull();
    // flags byte present but the declared 16-bit HR value is truncated
    const truncated = new DataView(new ArrayBuffer(2));
    truncated.setUint8(0, 0x01);
    expect(parseHeartRateMeasurement(truncated)).toBeNull();
  });
});
