---
paths:
  - "Dockerfile"
  - "docker-compose.yml"
  - ".dockerignore"
  - "scripts/bootstrap.ts"
  - "scripts/start-web.ts"
  - "lib/webBind.ts"
  - "lib/auth/**"
  - "middleware.ts"
  - "docs/self-hosting/**"
  - "config/*.example.json"
  - "deploy/**"
---

# Self-Hosting Packaging

Full design + verification narrative, including a real data-loss incident
hit during testing: tracked in Linear. This file is the current-state
design reference.

- **`Dockerfile`**: three stages — `deps` (`pnpm install --frozen-lockfile`,
  full prod+dev tree, needed since every non-Next script runs via `tsx`
  directly), `builder` (`pnpm build`), `runtime` (`node:22-slim`, non-root,
  reuses the base image's uid/gid-1000 `node` user). Runtime commands
  invoke `node_modules/.bin` binaries directly (`tsx`, `node server.js`),
  NOT `pnpm run <script>` — pnpm 11's dependency-status check wants a TTY
  that a container doesn't have. `package.json` pins
  `"packageManager": "pnpm@11.1.3"`. Web role runs
  `next.config.mjs`'s `output: 'standalone'` entrypoint via
  `scripts/start-web.ts` → `node server.js` (`next start` is documented as
  incompatible with standalone output).
- **`docker-compose.yml`**: default (no `--profile`) = `db`+`app`+`bot`;
  `--profile local-ai` = Ollama, `--profile local-routing` = self-hosted
  OpenRouteService (separate so a busy ORS port can't abort Ollama's `up`; always
  name the service); `--profile analytics` = the one-shot `dbt` container. Top-level `name: agon` pins the
  Compose project name (predictable container names regardless of checkout
  directory — see the Linear incident write-up for why this matters:
  never rely on directory-path-derived project names when testing in a
  temp directory that might share a compose file with production). Bind-
  mounts only `config/` (the only local file path the app itself reads at
  runtime).
- **Network exposure**: `lib/webBind.ts`'s `assertSafeBind()` refuses an
  all-interfaces bind for `AGON_WEB_BIND_HOST` unless
  `AGON_WEB_ALLOW_PUBLIC=true` — byte-for-byte the same shape as the
  sibling Hephaistos project's `webapp/config.py`. Docker path:
  `docker-compose.yml` binds `0.0.0.0` *inside* the container (safe —
  Docker's network namespace is the real boundary there) and controls REAL
  host exposure via the `ports:` mapping's `AGON_WEB_HOST_BIND_IP` (default
  `127.0.0.1`; set to your Tailscale IP to reach it from another device).
- **Login gate** (`lib/auth/`): `session.ts` (signed, TTL-bounded session
  cookie via Web Crypto `crypto.subtle` HMAC-SHA256 — NOT Node's `crypto`,
  so it works in both Middleware's Edge runtime and Node with one
  implementation), `rateLimit.ts` (5 failures/5min → 15min lockout,
  module-scoped state, correct for a single long-running process not
  stateless serverless), `cookie.ts` (public-path allowlist: `/login`,
  `/api/auth/*`, `/api/health`, `/api/telegram/webhook`). `middleware.ts` is
  the one choke point every request passes through. **Its login redirect is
  built from `X-Forwarded-Host`/`Host` + `X-Forwarded-Proto`, never from
  `request.url` alone**: in the standalone build `request.url` carries the bind
  address (`localhost:3100`), so behind `tailscale serve` a phone was bounced
  to an unreachable host. It must also stay absolute — Next middleware throws
  `ERR_INVALID_URL` on a relative `Location`
  (`__tests__/lib/middlewareRedirect.test.ts`). CSRF: `SameSite=Lax`
  blocks the practical vector; a per-session CSRF secret exists in the
  payload but isn't wired into every mutating route yet (deliberate,
  documented scope cut — tracked in Linear.
  - **`secretStore.ts`** (Node-only — Argon2 native binding + `fs`, never
    imported by `middleware.ts`): mirrors the sibling Hephaistos project's
    `webapp/auth/secret_store.py`. `AGON_WEB_SECRET` (the login password) is
    never compared or stored raw — `LoginSecretGate` verifies against an
    Argon2id hash, falling back to a constant-time plaintext compare only
    when no hash exists yet, and on that first successful login hashes +
    persists it to `data/auth/web-secret.hash` (bind-mounted read-write —
    `docker-compose.yml`'s `./data:/app/data`, 0600). No self-hoster action
    needed either way. `AGON_SESSION_SIGNING_KEY` is a SEPARATE secret
    (`scripts/bootstrap.ts`-generated, plain env var) that only signs the
    session cookie — deliberately not a persisted file like Hephaistos's
    signing key, because Next.js Middleware runs on the Edge runtime even
    self-hosted, and Edge code can't read a file `secretStore.ts` writes; an
    env var is the one representation both runtimes share. Rotating either
    secret never invalidates the other.
- **`scripts/bootstrap.ts`**: copies `.env.example`/config examples/
  training-program example to `.local.*` if absent (never overwrites),
  generates random secrets for vars that don't need a human to choose them.
  `setEnvVar` REPLACES an existing blank/comment-only line in place rather
  than appending — `scripts/loadEnv.ts` treats the first occurrence of a
  key as authoritative even when blank, so a naive append is silently
  shadowed.
- **Android shell** (MZY-274, `docs/self-hosting/android-app.md`): a
  sideloaded Capacitor APK that loads the server via
  `AGON_ANDROID_SERVER_URL`. `lib/androidShell.ts` refuses non-secure origins:
  https, or loopback over `adb reverse` in dev. For the tower that means
  `tailscale serve` HTTPS. Release keystore lives outside the repo
  (`AGON_ANDROID_KEYSTORE_*`); `allowBackup=false`.
- **Not yet exercised on the actual Linux tower** — see Linear (MZY-24).
