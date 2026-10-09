import type { z } from 'zod';
import type {
  LlmCompletionClient,
  StructuredCompletionRequest,
} from './completion';
import type {
  TranscriptionClient,
  TranscriptionRequest,
  TranscriptionResult,
} from './transcription';

// Fake adapters for the unit lane: no network, no API keys. They exercise the
// REAL boundary — FakeCompletionClient still runs the caller's zod schema over
// its canned JSON, so a fixture that doesn't match the schema fails the test
// exactly as a bad provider response would. This is how the whole voice pipeline
// is tested per CLAUDE.md ("Unit-test with a FAKE adapter — no live API").

/** Responder: given the request, return the raw JSON the "model" would emit. */
export type FakeResponder = (req: StructuredCompletionRequest) => unknown;

export class FakeCompletionClient implements LlmCompletionClient {
  public calls: StructuredCompletionRequest[] = [];

  constructor(private readonly responder: FakeResponder) {}

  async complete<S extends z.ZodTypeAny>(
    req: StructuredCompletionRequest<S>,
  ): Promise<z.output<S>> {
    this.calls.push(req);
    const raw = this.responder(req);
    // Validate through the caller's schema — same contract as a real adapter.
    return req.schema.parse(raw);
  }
}

/** Convenience: a client that always returns the same canned object. */
export function fakeCompletionReturning(value: unknown): FakeCompletionClient {
  return new FakeCompletionClient(() => value);
}

export class FakeTranscriptionClient implements TranscriptionClient {
  public calls: TranscriptionRequest[] = [];

  constructor(private readonly text: string) {}

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    this.calls.push(req);
    return { text: this.text };
  }
}
