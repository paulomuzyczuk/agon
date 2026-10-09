// Bind-safety guard for the web server, mirroring the sibling Hephaistos
// project's webapp/config.py mechanism exactly (self-hosting decision,
// CLAUDE.md "Network exposure"). The web app controls health data and can
// trigger integrations, so it must never be reachable from a public interface
// by accident. Secure default: bind to localhost (or a specific Tailscale IP)
// and REFUSE a wildcard all-interfaces bind unless the operator explicitly
// opts in. assertSafeBind is the one choke point — scripts/start-web.ts calls
// it before `next start` launches.
//
// wiki/topics/reversibility.md (Thomas & Hunt Ch.2): wrap the bind decision in
// one small helper so a self-hoster who wants a public reverse proxy instead
// only changes this one seam, not the app's routing.

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '']);

const DEFAULT_BIND_HOST = '127.0.0.1';
const DEFAULT_BIND_PORT = 3000;
// 7 days, fixed (no sliding renewal) — decided in MZY-28 for local-first use:
// long enough that a phone used offline for a weekend still syncs without a
// login prompt; writes made after it expires are kept in the device outbox
// and flush after the next sign-in (lib/outbox.ts), so expiry never loses data.
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export class BindSafetyError extends Error {}

export interface WebBindConfig {
  bindHost: string;
  bindPort: number;
  sessionTtlSeconds: number;
  allowPublic: boolean;
}

/** True if `host` is an all-interfaces wildcard (0.0.0.0 / :: / empty). */
export function isWildcardBind(host: string): boolean {
  return WILDCARD_HOSTS.has(host.trim());
}

/**
 * Refuse a public wildcard bind unless allowPublic was explicitly set. A
 * specific address (localhost or a Tailscale IP) is always fine — only the
 * all-interfaces wildcard is gated, because that is what reaches a public NIC.
 */
export function assertSafeBind(config: WebBindConfig): void {
  if (isWildcardBind(config.bindHost) && !config.allowPublic) {
    throw new BindSafetyError(
      `assertSafeBind: refusing to bind the all-interfaces wildcard host ` +
        `${JSON.stringify(config.bindHost)} — this exposes every network ` +
        `interface, including any public one. Bind 127.0.0.1 or your Tailscale ` +
        `IP instead, or set AGON_WEB_ALLOW_PUBLIC=true to override deliberately ` +
        `(only if you also run your own reverse proxy + TLS in front — see ` +
        `docs/self-hosting/network-exposure.md).`,
    );
  }
}

type EnvLike = Record<string, string | undefined>;

function intEnv(env: EnvLike, name: string, fallback: number): number {
  const raw = (env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(
      `loadWebBindConfig: env var ${name}=${raw} is not an integer`,
    );
  }
  return n;
}

/**
 * Build a WebBindConfig from environment variables, with safe defaults.
 * Throws if a numeric field is set to a non-integer — a misconfigured port
 * must fail loudly at startup, not silently fall back.
 */
export function loadWebBindConfig(env: EnvLike = process.env): WebBindConfig {
  return {
    bindHost: (env.AGON_WEB_BIND_HOST ?? '').trim() || DEFAULT_BIND_HOST,
    bindPort: intEnv(env, 'AGON_WEB_BIND_PORT', DEFAULT_BIND_PORT),
    sessionTtlSeconds: intEnv(
      env,
      'AGON_WEB_SESSION_TTL_SECONDS',
      DEFAULT_SESSION_TTL_SECONDS,
    ),
    allowPublic: TRUTHY.has(
      (env.AGON_WEB_ALLOW_PUBLIC ?? '').trim().toLowerCase(),
    ),
  };
}
