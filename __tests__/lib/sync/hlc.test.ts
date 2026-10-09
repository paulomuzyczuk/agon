import {
  clampHlc,
  compareHlc,
  formatHlc,
  HlcError,
  isHlc,
  parseHlc,
  receiveHlc,
  tickHlc,
  type Hlc,
} from '@/lib/sync/hlc';

const T = 1_790_000_000_000; // a fixed epoch ms

describe('format / parse', () => {
  it('round-trips and is fixed-width', () => {
    const h: Hlc = { wall: T, counter: 7, node: 'phone-a' };
    const s = formatHlc(h);
    expect(s).toBe('001790000000000:000007:phone-a');
    expect(parseHlc(s)).toEqual(h);
    expect(isHlc(s)).toBe(true);
  });

  it('rejects malformed stamps and nodes', () => {
    expect(() => parseHlc('1790000000000:7:a')).toThrow(HlcError);
    expect(() => formatHlc({ wall: T, counter: 0, node: 'has space' })).toThrow(HlcError);
    expect(() => formatHlc({ wall: T, counter: 1_000_000, node: 'a' })).toThrow(HlcError);
    expect(isHlc(42)).toBe(false);
  });

  it('string order equals compareHlc order', () => {
    const stamps = [
      formatHlc({ wall: T + 1, counter: 0, node: 'a' }),
      formatHlc({ wall: T, counter: 2, node: 'a' }),
      formatHlc({ wall: T, counter: 2, node: 'b' }),
      formatHlc({ wall: T, counter: 10, node: 'a' }),
    ];
    const byCompare = [...stamps].sort(compareHlc);
    const byString = [...stamps].sort();
    expect(byString).toEqual(byCompare);
  });
});

describe('compareHlc', () => {
  it('orders by wall, then counter, then node (deterministic tiebreak)', () => {
    const a = formatHlc({ wall: T, counter: 0, node: 'a' });
    const b = formatHlc({ wall: T, counter: 0, node: 'b' });
    const later = formatHlc({ wall: T, counter: 1, node: 'a' });
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, a)).toBe(1);
    expect(compareHlc(later, b)).toBe(1);
    expect(compareHlc(a, a)).toBe(0);
  });
});

describe('tickHlc', () => {
  it('follows physical time when it advances', () => {
    expect(tickHlc({ wall: T, counter: 5, node: 'a' }, T + 10, 'a')).toEqual({
      wall: T + 10,
      counter: 0,
      node: 'a',
    });
  });

  it('never goes backwards when the device clock is set back', () => {
    const next = tickHlc({ wall: T, counter: 5, node: 'a' }, T - 60_000, 'a');
    expect(next).toEqual({ wall: T, counter: 6, node: 'a' });
  });

  it('two events in the same ms are still strictly ordered', () => {
    const one = tickHlc(null, T, 'a');
    const two = tickHlc(one, T, 'a');
    expect(compareHlc(formatHlc(two), formatHlc(one))).toBe(1);
  });
});

describe('receiveHlc', () => {
  it('orders the next local event after a remote stamp from a fast clock', () => {
    const local: Hlc = { wall: T, counter: 0, node: 'a' };
    const remote: Hlc = { wall: T + 5_000, counter: 3, node: 'b' }; // b's clock is ahead
    const merged = receiveHlc(local, remote, T + 1, 'a');
    expect(merged).toEqual({ wall: T + 5_000, counter: 4, node: 'a' });
    const next = tickHlc(merged, T + 2, 'a');
    expect(compareHlc(formatHlc(next), formatHlc(remote))).toBe(1);
  });

  it('uses physical time when it is ahead of both', () => {
    expect(
      receiveHlc({ wall: T, counter: 9, node: 'a' }, { wall: T, counter: 9, node: 'b' }, T + 1, 'a'),
    ).toEqual({ wall: T + 1, counter: 0, node: 'a' });
  });

  it('bumps past both counters on an exact wall tie', () => {
    expect(
      receiveHlc({ wall: T, counter: 2, node: 'a' }, { wall: T, counter: 7, node: 'b' }, T, 'a'),
    ).toEqual({ wall: T, counter: 8, node: 'a' });
  });
});

describe('clampHlc (server guard against a future-set device clock)', () => {
  const hour = 3_600_000;
  it('leaves a stamp within the drift window alone', () => {
    const s = formatHlc({ wall: T + 60_000, counter: 1, node: 'a' });
    expect(clampHlc(s, T, 10 * 60_000)).toBe(s);
  });

  it('pulls a far-future stamp back to server time, keeping counter + node', () => {
    const s = formatHlc({ wall: T + 5 * hour, counter: 3, node: 'a' });
    expect(parseHlc(clampHlc(s, T, 10 * 60_000))).toEqual({ wall: T, counter: 3, node: 'a' });
  });
});
