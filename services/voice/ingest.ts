import type { LlmCompletionClient } from '../llm/completion';
import {
  parseLiftingPrompt,
  parseRunPrompt,
  parseBodyPrompt,
} from '../llm/prompts';
import { logger } from '../logger';
import { insertQualitativeLog } from '../qualitativeLogs';
import { recordCaptureEvent, type CaptureTarget } from '../captureEvents';
import { athleteLocalParts } from '../../lib/time';
import { getAthleteProfile } from '../../lib/athleteProfile';
import {
  liftingParseSchema,
  runParseSchema,
  bodyParseSchema,
  type CaptureType,
} from './schemas';
import { fanOutLifting, type LiftingFanOutResult } from './lifting';
import { fanOutRun, type RunFanOutResult } from './run';
import { fanOutBody, type BodyFanOutResult } from './body';

// The heart of the capture milestone: transcript + capture type → LLM parse →
// persist raw + parsed to qualitative_logs → fan out into the typed schema. The
// LlmCompletionClient is injected (DI) so the unit lane passes a FakeCompletionClient
// with canned JSON and the whole path runs with no network or keys.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A model-supplied date wins only if it's a real YYYY-MM-DD no later than the
 * capture date; else the capture date. The model resolves relative words
 * ("yesterday") against ITS notion of today, not the capture date — so a note
 * ingested late (a delayed voice note, a Telegram-export replay) came back dated
 * relative to the processing day and attached to the wrong run. A note can't
 * describe a day after it was captured, so a later date is rejected.
 */
export function resolveDate(
  parsedDate: string | null,
  capturedDate: string,
): string {
  if (
    parsedDate &&
    DATE_RE.test(parsedDate) &&
    !Number.isNaN(Date.parse(parsedDate)) &&
    parsedDate <= capturedDate
  ) {
    return parsedDate;
  }
  return capturedDate;
}

export interface VoiceNoteInput {
  captureType: CaptureType;
  transcript: string;
  /** Date the note was captured, YYYY-MM-DD; defaults to athlete-local today. */
  capturedDate?: string;
}

export interface VoiceIngestResult {
  captureType: CaptureType;
  qualitativeLogId: string;
  effectiveDate: string;
  lifting?: LiftingFanOutResult;
  run?: RunFanOutResult;
  body?: BodyFanOutResult;
}

export async function ingestVoiceNote(
  client: LlmCompletionClient,
  input: VoiceNoteInput,
): Promise<VoiceIngestResult> {
  const capturedDate =
    input.capturedDate ??
    athleteLocalParts(new Date().toISOString(), getAthleteProfile().timeZone)
      .date;

  if (input.captureType === 'lift') {
    const parse = await client.complete({
      prompt: parseLiftingPrompt,
      input: input.transcript,
      schema: liftingParseSchema,
    });
    const effectiveDate = resolveDate(parse.date, capturedDate);
    const qualitativeLogId = await insertQualitativeLog({
      date: effectiveDate,
      sessionType: 'lift',
      rawTranscript: input.transcript,
      parsedJson: parse,
    });
    const lifting = await fanOutLifting(parse, effectiveDate);
    await recordCaptureEvent({
      kind: 'voice-lift',
      summary: `lift session ${parse.session_type} (${lifting.exerciseCount} exercises, ${lifting.setCount} sets)`,
      targets: [
        { table: 'lifting_sessions', id: lifting.sessionId },
        { table: 'qualitative_logs', id: qualitativeLogId },
      ],
    });
    logger.info('voice note ingested', {
      job: 'voice-ingest',
      captureType: 'lift',
      exercises: lifting.exerciseCount,
      sets: lifting.setCount,
    });
    return { captureType: 'lift', qualitativeLogId, effectiveDate, lifting };
  }

  if (input.captureType === 'run') {
    const parse = await client.complete({
      prompt: parseRunPrompt,
      input: input.transcript,
      schema: runParseSchema,
    });
    const effectiveDate = resolveDate(parse.date, capturedDate);
    const qualitativeLogId = await insertQualitativeLog({
      date: effectiveDate,
      sessionType: 'run',
      rawTranscript: input.transcript,
      parsedJson: parse,
    });
    const run = await fanOutRun(parse, effectiveDate);
    if (run.unmatchedProducts.length > 0) {
      logger.warn('voice note had unmatched fueling products', {
        job: 'voice-ingest',
        captureType: 'run',
        unmatchedProducts: run.unmatchedProducts,
      });
    }
    // Undo targets: the log + fueling we added, and the run ONLY if we created it
    // (never a pre-existing Strava run we merely enriched).
    const runTargets: CaptureTarget[] = [
      { table: 'qualitative_logs', id: qualitativeLogId },
      ...run.fuelingItemIds.map((id) => ({ table: 'run_fueling_items', id })),
    ];
    if (run.runCreated && run.runId) {
      runTargets.push({ table: 'runs', id: run.runId });
    }
    await recordCaptureEvent({
      kind: 'voice-run',
      summary: `run note${run.runCreated ? ' (new run)' : ''}`,
      targets: runTargets,
    });
    return { captureType: 'run', qualitativeLogId, effectiveDate, run };
  }

  // body
  const parse = await client.complete({
    prompt: parseBodyPrompt,
    input: input.transcript,
    schema: bodyParseSchema,
  });
  const effectiveDate = resolveDate(parse.date, capturedDate);
  const qualitativeLogId = await insertQualitativeLog({
    date: effectiveDate,
    sessionType: 'body',
    rawTranscript: input.transcript,
    parsedJson: parse,
  });
  const body = await fanOutBody(parse, effectiveDate);
  const bodyTargets: CaptureTarget[] = [
    { table: 'qualitative_logs', id: qualitativeLogId },
  ];
  if (body.bodyMetricId) {
    bodyTargets.push({ table: 'body_metrics', id: body.bodyMetricId });
  }
  await recordCaptureEvent({
    kind: 'voice-body',
    summary: 'body measurement',
    targets: bodyTargets,
  });
  return { captureType: 'body', qualitativeLogId, effectiveDate, body };
}
