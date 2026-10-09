// A versioned, provider-neutral prompt template. Prompts live in files under
// services/llm/prompts/ and carry an explicit `version` so a change to the
// wording is a visible, reviewable edit (and could later be A/B'd or pinned).
//
// A template is pure data + a small render function: it never imports a provider
// SDK and never references a model. The LlmCompletionClient adapter is the only
// thing that knows which provider runs it. `system` frames the task; `buildUser`
// wraps the caller's input (a voice-note transcript) into the user turn.
export interface PromptTemplate {
  /** Stable identifier, e.g. 'parse-lifting'. */
  id: string;
  /** Bump on any wording change, e.g. 'v1'. */
  version: string;
  /** System framing — role, output contract (JSON only), field semantics. */
  system: string;
  /** Build the user turn from the raw transcript. */
  buildUser(transcript: string): string;
}
