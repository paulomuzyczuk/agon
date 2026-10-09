import { z } from 'zod';
import type { LlmCompletionClient } from '../llm/completion';
import { classifyCapturePrompt } from '../llm/prompts';
import { CAPTURE_TYPES, type CaptureType } from './schemas';

// Decide whether a transcript is a lift / run / body note, so a voice note needs
// no explicit mode from the athlete. A tiny LLM call validated against our own
// enum — same boundary discipline as the parsers.

export const captureClassificationSchema = z.object({
  capture_type: z.enum(CAPTURE_TYPES),
});

export async function classifyCaptureType(
  client: LlmCompletionClient,
  transcript: string,
): Promise<CaptureType> {
  const { capture_type } = await client.complete({
    prompt: classifyCapturePrompt,
    input: transcript,
    schema: captureClassificationSchema,
  });
  return capture_type;
}
