import {
  stravaSummaryActivitySchema,
  stravaTokenResponseSchema,
} from '@/services/strava/types';

// Strava moves Activity/Athlete ids to 64-bit after 2027-06-01. JSON.parse
// rounds anything above 2^53, so `id_str` must win over `id`.
const BIG = '9007199254740993'; // 2^53 + 1 — not representable as a JS number

const base = {
  distance: 10000,
  moving_time: 3000,
  elapsed_time: 3100,
  start_date: '2027-06-02T06:00:00Z',
  start_date_local: '2027-06-02T08:00:00Z',
};

describe('Strava 64-bit ids', () => {
  it('JSON.parse really does round the numeric id (premise check)', () => {
    const parsed = JSON.parse(`{"id": ${BIG}}`) as { id: number };
    expect(String(parsed.id)).not.toBe(BIG);
  });

  it('activity: id_str wins over the lossy numeric id', () => {
    const raw = JSON.parse(
      `{"id": ${BIG}, "id_str": "${BIG}", ${JSON.stringify(base).slice(1, -1)}}`,
    );
    expect(stravaSummaryActivitySchema.parse(raw).id).toBe(BIG);
  });

  it('activity: falls back to String(id) when id_str is absent (today)', () => {
    const a = stravaSummaryActivitySchema.parse({
      ...base,
      id: 18_000_000_000,
    });
    expect(a.id).toBe('18000000000');
  });

  it('activity: rejects a non-numeric id_str', () => {
    expect(() =>
      stravaSummaryActivitySchema.parse({ ...base, id: 1, id_str: 'abc' }),
    ).toThrow();
  });

  it('athlete on the token response: id_str wins', () => {
    const raw = JSON.parse(
      `{"token_type":"Bearer","access_token":"a","refresh_token":"r","expires_at":1,"expires_in":1,"athlete":{"id":${BIG},"id_str":"${BIG}"}}`,
    );
    expect(stravaTokenResponseSchema.parse(raw).athlete?.id).toBe(BIG);
  });
});
