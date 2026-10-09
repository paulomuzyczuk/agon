import pino from 'pino';

// MCP-layer logger. CRITICAL: the stdio transport uses STDOUT for the JSON-RPC
// protocol, so every log line MUST go to STDERR (fd 2) or it corrupts the stream.
// This is why the MCP server can't use the shared services/logger.ts (which
// writes to stdout). Same shape, different destination.

const pinoLogger = pino(
  { enabled: process.env.NODE_ENV !== 'test' },
  pino.destination(2), // stderr
);

export const mcpLog = {
  info(message: string, ctx: Record<string, unknown> = {}): void {
    pinoLogger.info(ctx, message);
  },
  warn(message: string, ctx: Record<string, unknown> = {}): void {
    pinoLogger.warn(ctx, message);
  },
  error(message: string, ctx: Record<string, unknown> = {}, err?: unknown): void {
    const errObj =
      err instanceof Error
        ? { message: err.message, name: err.name, stack: err.stack }
        : err !== undefined
          ? { message: String(err) }
          : undefined;
    pinoLogger.error(errObj ? { ...ctx, err: errObj } : ctx, message);
  },
};
