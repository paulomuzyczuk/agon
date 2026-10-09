import pino from 'pino';

// Structured logging (sihha convention). Kept dependency-free so anything may
// import it without cycle risk. Silent under NODE_ENV=test so the unit lane
// output stays clean.

export interface LogContext {
  job?: string;
  action?: string;
  status?: number;
  durationMs?: number;
  count?: number;
  [key: string]: unknown;
}

const pinoLogger = pino({ enabled: process.env.NODE_ENV !== 'test' });

function toErrObject(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack };
  }
  return { message: String(err) };
}

export const logger = {
  info(message: string, ctx: LogContext = {}): void {
    pinoLogger.info(ctx, message);
  },
  warn(message: string, ctx: LogContext = {}): void {
    pinoLogger.warn(ctx, message);
  },
  error(message: string, ctx: LogContext = {}, err?: unknown): void {
    const merged = err !== undefined ? { ...ctx, err: toErrObject(err) } : ctx;
    pinoLogger.error(merged, message);
  },
};
