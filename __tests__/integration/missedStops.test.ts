import { logger } from '@/services/logger';
import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import { upsertRide } from '@/services/strava/rideIngest';
import { upsertRun } from '@/services/strava/ingest';
import { upsertRideStreams, upsertRunStreams } from '@/services/runStreams';
import {
  detectNewMissedStops,
  getOpenSuggestionFor,
  notifyOpenSuggestions,
  postSyncMissedStops,
  resolveSuggestion,
  SuggestionStateError,
} from '@/services/missedStops';
import { applyCorrection } from '@/services/activityCorrectionFlow';
import { handleCommandText } from '@/services/telegram/handlers';
import type { RideRecord, RunRecord } from '@/lib/types';

// Integration lane (agon_test) for missed-stop suggestions (MZY-254):
// detection after sync, one row per activity, the Telegram nudge, apply via
// the MZY-253 late-stop trim, dismissals that stick, and hand trims that win.
// Home is a synthetic location; Open-Meteo is mocked.

jest.mock('@/services/weather/openMeteo', () => ({
  ...jest.requireActual('@/services/weather/openMeteo'),
  fetchRunWeather: jest.fn().mockResolvedValue(null),
}));

const EXT = 'itest-mzy254';
const HOME = { lat: 50, lng: 10 };
const M_PER_DEG = 111_195;
const saved: Record<string, string | undefined> = {};
const ENV = {
  AGON_HOME_LAT: String(HOME.lat),
  AGON_HOME_LNG: String(HOME.lng),
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_OWNER_CHAT_ID: '4242',
};

const startedAt = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();

/**
 * 1 Hz ride home: `rideS` s at 5.5 m/s ending ~at home, then a tail of
 * `tailS` s drifting at 0.2 m/s (moving-flagged when `tailMoving`).
 */
function stream(rideS: number, tailS: number, tailMoving = true) {
  const timeS = [0];
  const pos = [-rideS * 5.5];
  const d = [0];
  const moving = [true];
  const push = (n: number, v: number, mv: boolean) => {
    for (let i = 0; i < n; i++) {
      timeS.push(timeS.length);
      pos.push(pos[pos.length - 1]! + v);
      d.push(d[d.length - 1]! + Math.abs(v));
      moving.push(mv);
    }
  };
  push(rideS, 5.5, true);
  push(tailS, 0.2, tailMoving);
  return {
    timeS,
    distanceM: d,
    moving,
    lat: pos.map((m) => HOME.lat + m / M_PER_DEG),
    lng: pos.map(() => HOME.lng),
    heartrate: timeS.map(() => 140),
  };
}

async function seedRide(ext: string, tailS = 180) {
  const s = stream(600, tailS);
  const total = s.distanceM[s.distanceM.length - 1]! / 1000;
  const { id } = await upsertRide({
    date: startedAt().slice(0, 10),
    started_at: startedAt(),
    start_lat: s.lat[0]!,
    start_lng: HOME.lng,
    block: null,
    week: null,
    distance_km: Math.round(total * 1000) / 1000,
    duration_s: 600 + tailS,
    avg_hr: 140,
    max_hr: 150,
    avg_speed_kmh: 19,
    max_speed_kmh: 25,
    elevation_gain_m: 0,
    bike_used: null,
    external_id: ext,
    source: 'strava',
    origin: null,
  } as RideRecord);
  await upsertRideStreams(id, 'strava', s);
  return id;
}

beforeAll(() => {
  loadEnv();
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(async () => {
  await query(
    `DELETE FROM public.qualitative_logs
      WHERE parsed_json->>'rideId' IN (SELECT id::text FROM public.rides WHERE external_id LIKE $1)
         OR parsed_json->>'runId' IN (SELECT id::text FROM public.runs WHERE external_id LIKE $1)`,
    [`${EXT}%`],
  );
  for (const t of ['runs', 'rides']) {
    await query(`DELETE FROM public.${t} WHERE external_id LIKE $1`, [
      `${EXT}%`,
    ]);
  }
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await closeDbPool();
});

async function ours(ids: string[]) {
  return (await detectNewMissedStops()).filter((s) =>
    ids.includes(s.activityId),
  );
}

describe('detection', () => {
  it('flags a ride left running at home, once', async () => {
    const id = await seedRide(`${EXT}-a`);
    const [s, ...rest] = await ours([id]);
    expect(rest).toEqual([]);
    expect(s).toMatchObject({
      kind: 'ride',
      activityId: id,
      confidence: 'home',
      status: 'open',
    });
    expect(s!.trimS).toBeGreaterThanOrEqual(165); // the 15 s rolling window lags the slowdown a few s
    expect(await ours([id])).toEqual([]); // one row per activity
  });

  it('skips an activity the athlete already trimmed by hand', async () => {
    const id = await seedRide(`${EXT}-b`);
    await applyCorrection(
      'ride',
      id,
      [{ kind: 'late_stop', trimMin: 1 }],
      null,
    );
    expect(await ours([id])).toEqual([]);
  });

  it('ignores a run that stops promptly at home', async () => {
    const s = stream(600, 20);
    const { id } = await upsertRun({
      date: startedAt().slice(0, 10),
      started_at: startedAt(),
      start_lat: null,
      start_lng: null,
      block: null,
      week: null,
      distance_km: 3.304,
      duration_s: 620,
      avg_hr: 150,
      max_hr: 160,
      avg_pace_s_per_km: 187.65,
      elevation_gain_m: 0,
      shoe_used: null,
      strava_activity_id: null,
      external_id: `${EXT}-run`,
      source: 'strava',
      origin: null,
    } as RunRecord);
    await upsertRunStreams(id, 'strava', s);
    expect(await ours([id])).toEqual([]);
  });
});

describe('Telegram nudge', () => {
  it('sends each open suggestion once, with tap-to-send commands', async () => {
    const id = await seedRide(`${EXT}-c`);
    const [s] = await ours([id]);
    const sent: Array<[number, string]> = [];
    const send = async (chatId: number, text: string) => {
      sent.push([chatId, text]);
    };
    await notifyOpenSuggestions(send);
    const mine = sent.filter(([, t]) => t.includes(`/trim_${s!.shortId}`));
    expect(mine).toHaveLength(1);
    expect(mine[0]![0]).toBe(4242);
    expect(mine[0]![1]).toMatch(/^🏠 .*got home/);
    expect(mine[0]![1]).toContain(`/keep_${s!.shortId}`);

    sent.length = 0;
    await notifyOpenSuggestions(send);
    expect(sent.filter(([, t]) => t.includes(`/trim_${s!.shortId}`))).toEqual(
      [],
    );
  });

  it('warns, and keeps the suggestion pending, when the owner chat is not configured', async () => {
    const id = await seedRide(`${EXT}-e`);
    const [s] = await ours([id]);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const send = jest.fn();
    delete process.env.TELEGRAM_OWNER_CHAT_ID;
    try {
      expect(await notifyOpenSuggestions(send)).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('TELEGRAM_OWNER_CHAT_ID'),
        expect.objectContaining({ hasChatId: false, hasToken: true }),
      );
      const { rows } = await query<{ notified_at: string | null }>(
        'SELECT notified_at FROM public.missed_stop_suggestions WHERE id = $1',
        [s!.id],
      );
      expect(rows[0]!.notified_at).toBeNull();
    } finally {
      process.env.TELEGRAM_OWNER_CHAT_ID = ENV.TELEGRAM_OWNER_CHAT_ID;
      warn.mockRestore();
    }
  });

  it('stays quiet when nothing is pending, even unconfigured', async () => {
    await notifyOpenSuggestions(async () => {}); // drain whatever earlier tests left
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    delete process.env.TELEGRAM_OWNER_CHAT_ID;
    try {
      expect(await notifyOpenSuggestions(jest.fn())).toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      process.env.TELEGRAM_OWNER_CHAT_ID = ENV.TELEGRAM_OWNER_CHAT_ID;
      warn.mockRestore();
    }
  });

  it('never throws from the post-sync hook, even when sending fails', async () => {
    await seedRide(`${EXT}-d`);
    await expect(
      postSyncMissedStops(async () => {
        throw new Error('telegram down');
      }),
    ).resolves.toBeUndefined();
  });
});

describe('resolving', () => {
  it('/trim_<n> applies the late-stop trim through the correction flow', async () => {
    const id = await seedRide(`${EXT}-e`);
    const [s] = await ours([id]);
    const reply = await handleCommandText(`/trim_${s!.shortId}`, {
      today: '2026-09-30',
    });
    expect(reply).toMatch(/^✂️ Trimmed the last (2:[45]|3:0)\d off the ride/);

    const { rows } = await query<{
      corrected_fields: string[];
      sample_count: number;
      status: string;
    }>(
      `SELECT r.corrected_fields, rs.sample_count, m.status
         FROM public.rides r
         JOIN public.ride_streams rs ON rs.ride_id = r.id
         JOIN public.missed_stop_suggestions m ON m.ride_id = r.id
        WHERE r.id = $1`,
      [id],
    );
    expect(rows[0]!.status).toBe('applied');
    expect(rows[0]!.corrected_fields).toContain('distance_km');
    expect(rows[0]!.sample_count).toBeLessThan(700);
    expect(await getOpenSuggestionFor('ride', id)).toBeNull();

    await expect(
      resolveSuggestion({ id: s!.id }, 'apply'),
    ).rejects.toBeInstanceOf(SuggestionStateError);
  });

  it('/keep_<n> dismisses for good', async () => {
    const id = await seedRide(`${EXT}-f`);
    const [s] = await ours([id]);
    const reply = await handleCommandText(`/keep_${s!.shortId}`, {
      today: '2026-09-30',
    });
    expect(reply).toMatch(/won't ask again/);
    expect(await ours([id])).toEqual([]);
    const { rows } = await query<{ distance_km: number }>(
      'SELECT distance_km::float8 AS distance_km FROM public.rides WHERE id = $1',
      [id],
    );
    expect(rows[0]!.distance_km).toBeGreaterThan(3.3);
  });

  it('a hand trim on the page stales the open suggestion', async () => {
    const id = await seedRide(`${EXT}-g`);
    const [s] = await ours([id]);
    await applyCorrection(
      'ride',
      id,
      [{ kind: 'late_stop', trimMin: 2 }],
      null,
    );
    const reply = await handleCommandText(`/trim_${s!.shortId}`, {
      today: '2026-09-30',
    });
    expect(reply).toMatch(/already stale/);
  });
});
