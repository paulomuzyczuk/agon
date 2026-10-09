import { loadEnv } from '@/scripts/loadEnv';
import { query, closeDbPool } from '@/services/db';
import {
  saveSuggestionBatch,
  getSuggestion,
  attachSuggestionToPlannedSession,
} from '@/services/routeSuggestions';
import type { SuggestRoutesResult } from '@/services/routing/generate';

// Integration lane — requires a live local Postgres with migrations applied:
//   pnpm db:up && pnpm migrate && pnpm test:integration
//
// Proves a suggestion batch persists (with rendered GPX + Maps link), reads back,
// and attaches to a planned_sessions row (the planned-vs-actual composition).

loadEnv();

function sampleResult(): SuggestRoutesResult {
  return {
    start: { lat: 52.5163, lng: 13.3777, label: 'home' },
    targetKm: 25,
    profile: 'foot-walking',
    candidates: [
      {
        seed: 2,
        distanceM: 24900,
        elevationGainM: 210,
        elevationGainPerKmM: 210 / 24.9,
        distanceErrorM: 100,
        coordinates: [
          [13.3777, 52.5163, 42],
          [13.3851, 52.5169, 45],
          [13.3777, 52.5163, 42],
        ],
        provider: 'openrouteservice',
      },
      {
        seed: 1,
        distanceM: 26000,
        elevationGainM: 300,
        elevationGainPerKmM: 300 / 26,
        distanceErrorM: 1000,
        coordinates: [[13.3777, 52.5163, 42]],
        provider: 'openrouteservice',
      },
    ],
  };
}

let plannedSessionId: string;
// Track only the batches this test creates so cleanup NEVER deletes real route
// data from the shared local DB (a blanket DELETE once wiped the auto routes).
const createdBatchIds: string[] = [];

async function saveTracked() {
  const r = await saveSuggestionBatch(sampleResult());
  createdBatchIds.push(r.batchId);
  return r;
}

beforeAll(async () => {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO public.planned_sessions (date, session_kind, description)
     VALUES ('2026-08-15', 'run', 'route-test session') RETURNING id`,
  );
  plannedSessionId = rows[0]!.id;
});

afterAll(async () => {
  await query(
    'DELETE FROM public.route_suggestions WHERE batch_id = ANY($1::uuid[])',
    [createdBatchIds],
  );
  await query('DELETE FROM public.planned_sessions WHERE id = $1', [
    plannedSessionId,
  ]);
  await closeDbPool();
});

describe('route_suggestions persistence', () => {
  it('saves a batch with rendered GPX + maps link and reads it back', async () => {
    const { batchId, suggestions } = await saveTracked();
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(suggestions).toHaveLength(2);
    // rank order preserved (best candidate first, rank 1)
    expect(suggestions[0]!.rank).toBe(1);
    expect(suggestions[0]!.seed).toBe(2);
    expect(suggestions[0]!.gpx).toContain('<gpx version="1.1"');
    expect(suggestions[0]!.mapsUrl).toContain('travelmode=walking');

    const fetched = await getSuggestion(suggestions[0]!.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.distanceM).toBe(24900);
    expect(fetched!.elevationGainM).toBe(210);
    expect(fetched!.plannedSessionId).toBeNull();
  });

  it('attaches a suggestion to a planned session (idempotent)', async () => {
    const { suggestions } = await saveTracked();
    const id = suggestions[0]!.id;

    const info = await attachSuggestionToPlannedSession(id, plannedSessionId);
    expect(info).toEqual({ plannedDate: '2026-08-15', sessionKind: 'run' });

    const after = await getSuggestion(id);
    expect(after!.plannedSessionId).toBe(plannedSessionId);

    // Re-attaching the same pair is a no-op, not an error.
    await expect(
      attachSuggestionToPlannedSession(id, plannedSessionId),
    ).resolves.toBeDefined();
  });

  it('throws on an unknown planned session id', async () => {
    const { suggestions } = await saveTracked();
    await expect(
      attachSuggestionToPlannedSession(
        suggestions[0]!.id,
        '00000000-0000-0000-0000-000000000000',
      ),
    ).rejects.toThrow(/no planned_session/);
  });
});
