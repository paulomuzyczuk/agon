// Extract a JSON object from an LLM's text reply. Models sometimes wrap JSON in
// ```json fences or add a stray sentence; we ask for JSON-only in the prompt but
// defend against both here. Returns the parsed value (unknown) for the caller's
// zod schema to validate — this function never trusts the shape, only isolates
// the JSON substring and JSON.parses it.
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Strip a leading/trailing markdown code fence if present.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const body = fence ? fence[1]! : trimmed;

  // Fast path: the whole thing is JSON.
  try {
    return JSON.parse(body);
  } catch {
    // fall through to substring extraction
  }

  // Fallback: grab the outermost {...} or [...] span.
  const start = body.search(/[{[]/);
  const lastObj = body.lastIndexOf('}');
  const lastArr = body.lastIndexOf(']');
  const end = Math.max(lastObj, lastArr);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `llm: response contained no JSON object (${text.slice(0, 120)}…)`,
    );
  }
  return JSON.parse(body.slice(start, end + 1));
}
