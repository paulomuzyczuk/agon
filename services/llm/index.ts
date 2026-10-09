// Public surface of the provider-neutral LLM module (CLAUDE.md "Model
// Portability — No LLM Lock-In"). Callers depend on these interfaces and
// factories only — never on an adapter or a provider SDK directly.
export type {
  LlmCompletionClient,
  StructuredCompletionRequest,
  CompletionClientConfig,
} from './completion';
export { getCompletionClient, completionConfigFromEnv } from './completion';

export type {
  TranscriptionClient,
  TranscriptionRequest,
  TranscriptionResult,
  TranscriptionClientConfig,
} from './transcription';
export {
  getTranscriptionClient,
  transcriptionConfigFromEnv,
} from './transcription';

export type { PromptTemplate } from './prompts';
export { parseLiftingPrompt, parseRunPrompt, parseBodyPrompt } from './prompts';

export {
  FakeCompletionClient,
  FakeTranscriptionClient,
  fakeCompletionReturning,
} from './fakes';
export { extractJson } from './json';
