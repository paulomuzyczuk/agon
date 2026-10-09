// Low-level OpenRouteService HTTP client. Mirrors the fetch/error shape of the
// other adapters (services/googleCalendar/client.ts): a dedicated rate-limit
// error class, non-2xx → thrown Error with the response body. ORS authenticates
// with a plain API key (no OAuth), passed in the Authorization header.
//
// Base URL is configurable (ORS_BASE_URL) so a future self-hosted ORS on the
// Hetzner VPS is a config change, not a code change — the provider-neutrality
// principle from CLAUDE.md ("no single vendor can paywall the pipeline").

const DEFAULT_BASE_URL = 'https://api.openrouteservice.org';

export class OrsRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrsRateLimitError';
  }
}

export class OrsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrsConfigError';
  }
}

export function orsBaseUrl(): string {
  return (process.env.ORS_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Base URL for GEOCODING calls. A self-hosted ORS provides routing but NOT the
 * Pelias geocoder, so `ORS_GEOCODE_BASE_URL` lets routing point at a local ORS
 * (`ORS_BASE_URL`) while geocoding stays on the hosted free tier. Defaults to
 * ORS_GEOCODE_BASE_URL, else the hosted API (NOT ORS_BASE_URL — a local routing
 * host would 404 on /geocode).
 */
export function orsGeocodeBaseUrl(): string {
  return (process.env.ORS_GEOCODE_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    '',
  );
}

// Optional client-side throttle. The ORS free tier caps directions at ~40
// req/min; generating a diverse pool per run across a whole calendar sync can
// exceed that. When ORS_MIN_INTERVAL_MS is set (the gcal:sync path sets it), we
// space requests to stay under the limit. Unset (default) → no delay, so the
// interactive `route:suggest` stays fast. All our ORS calls are sequential, so a
// single last-call timestamp suffices.
let orsLastCallAt = 0;
async function orsThrottle(): Promise<void> {
  const minMs = Number(process.env.ORS_MIN_INTERVAL_MS) || 0;
  if (minMs <= 0) return;
  const wait = orsLastCallAt + minMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  orsLastCallAt = Date.now();
}

export function orsApiKey(): string {
  const key = process.env.ORS_API_KEY;
  if (!key) {
    throw new OrsConfigError(
      'openrouteservice: ORS_API_KEY must be set (sign up free at ' +
        'openrouteservice.org → Dashboard → request a token)',
    );
  }
  return key;
}

/**
 * Fetch a path under the ORS base URL with the API key attached. `init.body`,
 * when present, is sent as JSON. Non-2xx bodies are surfaced in the thrown
 * error so failures are debuggable; 429 becomes OrsRateLimitError so callers can
 * back off cleanly (mirrors the GoogleCalendar rate-limit handling).
 */
export async function orsFetch(
  path: string,
  init?: RequestInit,
  baseUrl: string = orsBaseUrl(),
): Promise<Response> {
  await orsThrottle();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: orsApiKey(),
      Accept:
        'application/json, application/geo+json, application/gpx+xml, */*',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 429) {
    const text = await res.text().catch(() => '');
    throw new OrsRateLimitError(
      `openrouteservice: rate limit on ${path} (HTTP 429) ${text}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // An exhausted DAILY quota comes back as 403 {"error":"Quota exceeded"},
    // not 429 — same meaning for callers (back off / fall back), so same class.
    if (res.status === 403 && /quota exceeded/i.test(text)) {
      throw new OrsRateLimitError(
        `openrouteservice: quota exceeded on ${path} (HTTP 403) ${text}`,
      );
    }
    throw new Error(
      `openrouteservice: ${init?.method ?? 'GET'} ${path} failed ` +
        `(${res.status} ${res.statusText}) ${text}`,
    );
  }
  return res;
}
