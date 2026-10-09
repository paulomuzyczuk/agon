import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEnv } from './loadEnv';
import { createMcpServer } from '../services/mcp/server';
import { closeReadPool } from '../services/mcp/readonlyDb';
import { mcpLog } from '../services/mcp/log';

// Agon MCP consulting server — stdio entry point. An MCP client (Claude
// Desktop/Code) launches this as a subprocess and speaks JSON-RPC over stdout,
// so NOTHING may write to stdout except the transport (all logging → stderr, see
// services/mcp/log.ts).
//
//   pnpm mcp
//
// Wire it into Claude Code via .mcp.json (in the repo root).

async function main(): Promise<void> {
  loadEnv();
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpLog.info('agon MCP server ready (stdio)', {
    job: 'mcp-server',
    vault: process.env.AGON_VAULT_PATH ? 'configured' : 'unset',
  });

  const shutdown = async (): Promise<void> => {
    await server.close().catch(() => {});
    await closeReadPool().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  mcpLog.error('mcp-server failed to start', { job: 'mcp-server' }, err);
  process.exit(1);
});
