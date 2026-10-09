import type { PoolClient } from 'pg';
import { query } from './db';

// Storage for the raw voice-note capture: the transcript plus the LLM's parsed
// JSON, before/independent of the fan-out into typed tables. This is the audit
// trail — if a parse is later found wrong, the original transcript + parsed_json
// are here to re-run. One row per voice note.

export interface QualitativeLogRecord {
  date: string; // YYYY-MM-DD
  sessionType: string | null; // 'run' / 'ride' / 'lift' / 'body'
  rawTranscript: string | null;
  parsedJson: unknown; // stored as JSONB
}

/** Insert a qualitative log; returns the new row id. Pass `db` to write inside a transaction. */
export async function insertQualitativeLog(
  r: QualitativeLogRecord,
  db?: Pick<PoolClient, 'query'>,
): Promise<string> {
  const run = db ? db.query.bind(db) : query;
  const { rows } = await run<{ id: string }>(
    `INSERT INTO public.qualitative_logs
       (date, session_type, raw_transcript, parsed_json)
     VALUES ($1,$2,$3,$4)
     RETURNING id`,
    [
      r.date,
      r.sessionType,
      r.rawTranscript,
      r.parsedJson === undefined ? null : JSON.stringify(r.parsedJson),
    ],
  );
  return rows[0]!.id;
}
