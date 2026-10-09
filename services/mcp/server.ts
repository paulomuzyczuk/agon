import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mcpLog } from './log';
import { describeSchema, runReadOnlySql } from './sql';
import {
  athleteProfile,
  recentRuns,
  weeklyPlan,
  trainingSummary,
  bodyTrend,
  wellnessSummary,
  dataFreshness,
  healthSummary,
} from './curated';
import { nutritionSummary } from './curatedNutrition';
import { recentRides, gearSummary } from './curatedRides';
import { listVaultPages, searchVault, readVaultPage } from './vault';
import { suggestRoutesText } from './routes';
import { ROUTE_PROFILES, HILL_PREFERENCES } from '../routing/types';

// The Agon MCP consulting server: read-only DB + knowledge-vault tools for any
// MCP client. Model-agnostic by construction (CLAUDE.md "No LLM Lock-In") — it
// exposes data + tools only, with no prompts, provider SDKs, or model-specific
// behavior. All DB access is read-only (READ ONLY transactions in readonlyDb.ts).

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
});

const fail = (err: unknown): ToolResult => ({
  content: [
    {
      type: 'text',
      text: `Error: ${err instanceof Error ? err.message : String(err)}`,
    },
  ],
  isError: true,
});

/** Wrap a tool body so failures surface to the model as text, not transport errors. */
function guard(
  name: string,
  fn: () => Promise<string>,
): () => Promise<ToolResult> {
  return async () => {
    try {
      return ok(await fn());
    } catch (err) {
      mcpLog.error('tool failed', { tool: name }, err);
      return fail(err);
    }
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'agon', version: '0.1.0' },
    {
      instructions:
        "Agon consulting layer — read-only access to a hybrid athlete's training, " +
        'nutrition, biometric, and general-health data (lab tests, injuries, ' +
        'medications, skincare/dental routines, medical visits, vaccinations, ' +
        'allergies/conditions) plus a sports-science knowledge vault. Use the ' +
        'curated tools for common questions; fall back to run_sql (SELECT-only) for ' +
        'anything custom, and describe_schema to see the tables first (rows with ' +
        'deleted_at set are deleted — filter deleted_at IS NULL). Always interpret ' +
        'running, lifting, and nutrition together (cross-domain).',
    },
  );

  // ── Schema + SQL escape hatch ───────────────────────────────────────────────
  server.registerTool(
    'describe_schema',
    {
      title: 'Describe schema',
      description:
        'List every public table and its columns. Call this before run_sql to write correct queries.',
    },
    guard('describe_schema', () => describeSchema()),
  );

  server.registerTool(
    'run_sql',
    {
      title: 'Run read-only SQL',
      description:
        'Run a single read-only SELECT/WITH query against the Postgres database and ' +
        'return up to 500 rows as JSON. Writes are impossible (read-only transaction). ' +
        'Use describe_schema first.',
      inputSchema: {
        sql: z.string().describe('A single SELECT or WITH statement'),
      },
    },
    async ({ sql }) => {
      try {
        const { rows, rowCount, truncated } = await runReadOnlySql(sql);
        const note = truncated
          ? `Showing first ${rows.length} of ${rowCount} rows.\n\n`
          : `${rowCount} row(s).\n\n`;
        return ok(note + JSON.stringify(rows, null, 2));
      } catch (err) {
        mcpLog.error('run_sql failed', {}, err);
        return fail(err);
      }
    },
  );

  // ── Curated domain tools ────────────────────────────────────────────────────
  server.registerTool(
    'athlete_profile',
    {
      title: 'Athlete profile',
      description: 'Static athlete profile + program overview.',
    },
    guard('athlete_profile', async () => athleteProfile()),
  );

  server.registerTool(
    'recent_runs',
    {
      title: 'Recent runs',
      description:
        'Most recent runs with distance, duration, avg HR, pace, and source.',
      inputSchema: { limit: z.number().int().positive().max(100).optional() },
    },
    async ({ limit }) => guard('recent_runs', () => recentRuns(limit))(),
  );

  server.registerTool(
    'recent_rides',
    {
      title: 'Recent bike rides',
      description:
        'Most recent bike rides with distance, duration, avg HR, avg speed, avg power + kJ, and source. Power is labelled by provenance: "(est.)" is the source\'s model (no power meter), "(manual)" was hand-entered; an unlabelled value was measured by a power meter. NP / IF / TSS are computed by Agon from measured power-meter streams only (empty otherwise; IF/TSS also need an FTP in the athlete profile). TSS is per ride and is NOT part of training load (that stays Relative Effort).',
      inputSchema: { limit: z.number().int().positive().max(100).optional() },
    },
    async ({ limit }) => guard('recent_rides', () => recentRides(limit))(),
  );

  server.registerTool(
    'gear_summary',
    {
      title: 'Gear mileage summary',
      description:
        'Total mileage per gear item (shoes, bikes, HRMs, ...), summed across runs and rides.',
    },
    guard('gear_summary', () => gearSummary()),
  );

  server.registerTool(
    'weekly_plan',
    {
      title: 'Weekly plan',
      description:
        'Planned sessions for the program week containing the given date (default: today).',
      inputSchema: { date: z.string().describe('YYYY-MM-DD').optional() },
    },
    async ({ date }) => guard('weekly_plan', () => weeklyPlan(date))(),
  );

  server.registerTool(
    'training_summary',
    {
      title: 'Training summary',
      description:
        'Run + lift volume over a date range, with per-week run distance. `from` required.',
      inputSchema: {
        from: z.string().describe('YYYY-MM-DD (inclusive)'),
        to: z
          .string()
          .describe('YYYY-MM-DD (inclusive, default today)')
          .optional(),
      },
    },
    async ({ from, to }) =>
      guard('training_summary', () => trainingSummary(from, to))(),
  );

  server.registerTool(
    'body_trend',
    {
      title: 'Body trend',
      description: 'Body weight / body-fat measurements over time.',
      inputSchema: { from: z.string().describe('YYYY-MM-DD').optional() },
    },
    async ({ from }) => guard('body_trend', () => bodyTrend(from))(),
  );

  server.registerTool(
    'wellness_summary',
    {
      title: 'Wellness summary',
      description: 'Recent resting HR, steps, HRV, and sleep by day.',
      inputSchema: { from: z.string().describe('YYYY-MM-DD').optional() },
    },
    async ({ from }) =>
      guard('wellness_summary', () => wellnessSummary(from))(),
  );

  server.registerTool(
    'data_freshness',
    {
      title: 'Data freshness',
      description:
        'Latest date + row count per key table — a data-pipeline health check.',
    },
    guard('data_freshness', () => dataFreshness()),
  );

  server.registerTool(
    'nutrition_summary',
    {
      title: 'Nutrition summary',
      description:
        'Water goal (base + estimated loss from planned exercise), supplement ' +
        'goals, logged intake so far, and the usual-meal templates, for a date ' +
        '(default today). Actual daily intake is tracked in Cronometer, not this app.',
      inputSchema: { date: z.string().describe('YYYY-MM-DD').optional() },
    },
    async ({ date }) =>
      guard('nutrition_summary', () => nutritionSummary(date))(),
  );

  server.registerTool(
    'health_summary',
    {
      title: 'General health summary',
      description:
        'Cross-domain general-health snapshot: out-of-range lab test results ' +
        '(blood panels, spermogram, hormone panels, ...), recent test panels, ' +
        'active injuries, active medications/supplements, active allergies/' +
        'chronic conditions, 7-day skincare/dental routine adherence, and ' +
        'upcoming medical-visit/vaccination follow-ups.',
    },
    guard('health_summary', () => healthSummary()),
  );

  // ── Route builder ───────────────────────────────────────────────────────────
  server.registerTool(
    'suggest_routes',
    {
      title: 'Suggest running/cycling routes',
      description:
        'Generate target-distance route suggestions from a start point (default: ' +
        "the athlete's home). Without `end_*`/`via` it returns LOOPS. With " +
        '`end_place` (or `end_lat`+`end_lng`) it returns ONE-WAY routes finishing ' +
        'there; `via` lists places or areas to pass through in order. An area ' +
        '(e.g. "Grunewald") keeps the detour inside it. The route is stretched ' +
        'to `target_km` by a detour. Returns a few candidates ranked by how ' +
        'close each is to the target distance, then by least elevation gain, ' +
        'each with a Google Maps link (walking or bicycling, per mode). Uses ' +
        'OpenStreetMap routing (OpenRouteService, with an OSRM fallback when its ' +
        'quota runs out). `mode` selects foot-walking (default) or a bike ' +
        'mode: cycling-regular, cycling-road (paved) or cycling-mountain ' +
        '(gravel/MTB); `hills` (flat|hilly) sets a bike gradient preference. ' +
        'Read-only: to save a set and export GPX for a watch, ' +
        'run the `pnpm route:suggest … --save` command printed in the output.',
      inputSchema: {
        target_km: z
          .number()
          .positive()
          .describe('Desired loop distance in km'),
        start_place: z
          .string()
          .describe(
            'Start location as a place/address (geocoded); omit for home',
          )
          .optional(),
        start_lat: z
          .number()
          .describe('Explicit start latitude (with start_lng)')
          .optional(),
        start_lng: z
          .number()
          .describe('Explicit start longitude (with start_lat)')
          .optional(),
        end_place: z
          .string()
          .describe(
            'Finish location as a place/address (geocoded; name the Bezirk to ' +
              'disambiguate, e.g. "Schloßstraße 1, Steglitz"). Omit for a loop.',
          )
          .optional(),
        end_lat: z
          .number()
          .describe('Explicit finish latitude (with end_lng)')
          .optional(),
        end_lng: z
          .number()
          .describe('Explicit finish longitude (with end_lat)')
          .optional(),
        via: z
          .array(z.string())
          .max(5)
          .describe(
            'Places or areas to pass through, in order, e.g. ["Grunewald", ' +
              '"Krumme Lanke"]',
          )
          .optional(),
        count: z
          .number()
          .int()
          .positive()
          .max(5)
          .describe('How many routes (default 3)')
          .optional(),
        include_gpx: z
          .boolean()
          .describe("Append the top route's GPX document (default false)")
          .optional(),
        mode: z
          .enum(ROUTE_PROFILES)
          .describe(
            'Travel mode — running loop or bike loop (default foot-walking)',
          )
          .optional(),
        hills: z
          .enum(HILL_PREFERENCES)
          .describe('Gradient preference for bike modes (ignored on foot)')
          .optional(),
      },
    },
    async ({
      target_km,
      start_place,
      start_lat,
      start_lng,
      end_place,
      end_lat,
      end_lng,
      via,
      count,
      include_gpx,
      mode,
      hills,
    }) =>
      guard('suggest_routes', () =>
        suggestRoutesText({
          targetKm: target_km,
          startPlace: start_place,
          startLat: start_lat,
          startLng: start_lng,
          endPlace: end_place,
          endLat: end_lat,
          endLng: end_lng,
          via,
          count,
          includeGpx: include_gpx,
          profile: mode,
          hills,
        }),
      )(),
  );

  // ── Knowledge vault ─────────────────────────────────────────────────────────
  server.registerTool(
    'list_vault_pages',
    {
      title: 'List vault pages',
      description: 'List every page in the sports-science knowledge vault.',
    },
    guard('list_vault_pages', async () => {
      const pages = await listVaultPages();
      return pages.length ? pages.join('\n') : '_vault is empty_';
    }),
  );

  server.registerTool(
    'search_vault',
    {
      title: 'Search vault',
      description:
        'Case-insensitive search across the knowledge vault; returns matching lines.',
      inputSchema: { query: z.string() },
    },
    async ({ query }) =>
      guard('search_vault', async () => {
        const matches = await searchVault(query);
        return matches.length
          ? matches.map((m) => `${m.page}:${m.line}: ${m.text}`).join('\n')
          : `_no matches for "${query}"_`;
      })(),
  );

  server.registerTool(
    'read_vault_page',
    {
      title: 'Read vault page',
      description:
        'Return the full markdown of one vault page (name with or without .md).',
      inputSchema: { page: z.string() },
    },
    async ({ page }) => guard('read_vault_page', () => readVaultPage(page))(),
  );

  return server;
}
