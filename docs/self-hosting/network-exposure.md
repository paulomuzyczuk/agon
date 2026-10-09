# Network Exposure: Tailscale + the Login Gate

Agon defaults to **not reachable from anywhere but your own machine**. Making
it reachable from your phone/laptop is a deliberate two-part setup:
[Tailscale](https://tailscale.com/) so only your own devices can reach it at
all, and a login gate so reachability alone isn't treated as authentication.
Both matter — see "Why both" below.

## Why Tailscale, not a reverse proxy + TLS

A self-hoster who wants remote access has two realistic options: run
Tailscale (a private mesh VPN — install once, your devices see each other by
a stable private IP, everyone else sees nothing), or run their own reverse
proxy with a public DNS name and a TLS certificate (Let's Encrypt, etc.),
port-forwarded through their router.

Agon defaults to Tailscale because the second path is real, ongoing
operational burden — certificate renewal, DNS, router port-forwarding — for
what is fundamentally a single-user quantified-self tool, not a public
product. Tailscale is also already proven on the same kind of hardware by
the sibling Hephaistos project. If you'd rather run a public reverse proxy
instead, you can (see "Public exposure instead" below) — it's just not the
default.

## Setup

1. Install Tailscale on the host running Agon and log in:
   <https://tailscale.com/download>. Install it on your phone/laptop too and
   log into the **same** Tailscale account (or an account you've shared the
   host with).
2. Find the host's Tailscale IP: `tailscale ip -4` (looks like `100.x.y.z`).
3. In `.env.local`, set:
   ```sh
   AGON_WEB_HOST_BIND_IP=100.x.y.z   # your Tailscale IP from step 2
   ```
4. Restart the app: `docker compose --env-file .env.local up -d app`.
5. From your phone (on the same tailnet), browse to `http://100.x.y.z:3000`.

If you only ever access Agon from the same machine it runs on, you can skip
Tailscale entirely and leave `AGON_WEB_HOST_BIND_IP` at its default
(`127.0.0.1`) — or use an SSH tunnel from another device
(`ssh -L 3000:127.0.0.1:3000 you@host`) instead of installing Tailscale.

## How the bind-safety mechanism works

Two different layers, depending on how you run the app:

**Running via Docker (the packaged path, `docker-compose.yml`)** — the `app`
service binds `0.0.0.0` *inside its own container* (safe: Docker's network
namespace is the isolation boundary at that level) and sets
`AGON_WEB_ALLOW_PUBLIC=true` to satisfy its own guard. The REAL host-level
exposure is controlled by the `ports:` mapping's host-IP prefix, driven by
`AGON_WEB_HOST_BIND_IP` (defaults to `127.0.0.1` — loopback-only, safe by
default even though the in-container bind is the wildcard).

**Running `pnpm start` directly on a host (no Docker)** — `lib/webBind.ts`'s
`assertSafeBind()` is the real guard here: it refuses an all-interfaces
(`0.0.0.0`/`::`/empty) bind for `AGON_WEB_BIND_HOST` unless
`AGON_WEB_ALLOW_PUBLIC=true` is set explicitly. `scripts/start-web.ts` is the
one place this runs — it validates the bind target *before* the server ever
opens a socket, then execs `node server.js` (the `output: 'standalone'`
entrypoint) with `PORT`/`HOSTNAME` pinned to that validated target. Set
`AGON_WEB_BIND_HOST` to your Tailscale IP directly in this mode.

Either way, the Telegram bot needs **no** exposure at all — it long-polls
Telegram (dials out), never listens for inbound connections.

## Why both: Tailscale + a login gate

"Reachable only via Tailscale" is not itself authentication — anyone else
sharing your tailnet (family members, other devices you've authorized) could
otherwise open your dashboard with no further check. Agon's login gate
(`middleware.ts` + `lib/auth/`) closes that gap: every route except `/login`
and a couple of unauthenticated system endpoints (`/api/health`, the
Telegram webhook — which has its own secret-token check) requires a valid
signed session cookie.

- **One shared secret** (`AGON_WEB_SECRET`) — `pnpm bootstrap` generates one
  for you; find it with `grep AGON_WEB_SECRET .env.local`, or set your own.
  It's never stored or compared in plaintext: `lib/auth/secretStore.ts`
  hashes it (Argon2id) into `data/auth/web-secret.hash` on your first
  successful login and checks the hash from then on — nothing you need to do.
- **A separate signing key** (`AGON_SESSION_SIGNING_KEY`, also
  bootstrap-generated) — signs the session cookie below. Kept apart from the
  login password on purpose: rotating one never invalidates the other.
- **Signed, HttpOnly session cookie** (`lib/auth/session.ts`) — HMAC-SHA256
  via the Web Crypto API, fixed 7-day TTL by default
  (`AGON_WEB_SESSION_TTL_SECONDS`). Writes made after it expires are kept on
  the device and sync after you sign in again.
- **Rate-limited login** (`lib/auth/rateLimit.ts`) — 5 failed attempts in 5
  minutes locks that client out for 15 minutes, even against the correct
  secret.
- **CSRF**: the session cookie is `SameSite=Lax`, which already blocks it
  riding along on a cross-site POST in every modern browser — the practical
  CSRF vector. The session payload also carries a per-session CSRF secret for
  a stricter token-verification pass, but that isn't wired into every
  existing mutating API route yet (deliberately deferred, not silently
  half-built — see `CLAUDE.md`'s self-hosting network-exposure entry).

Log in at `/login`; log out by clearing the `agon_session` cookie (or wait
out the TTL).

## Public exposure instead

If you'd rather run your own reverse proxy + TLS and expose Agon publicly:
run that proxy in front of the container and set `AGON_WEB_ALLOW_PUBLIC=true`
(for the direct-host `pnpm start` path) or point `AGON_WEB_HOST_BIND_IP` at
`0.0.0.0` (for the Docker path — publishes on every host interface).
**Do not do this without the login gate in place** (it already is, by
default) — the network-position assumption disappears once the app is
reachable from the open internet, and the login gate is what stands between
a stranger and your health data at that point. `lib/webBind.ts`'s
`loadWebBindConfig`/`assertSafeBind` pair is one small seam (per
`wiki/topics/reversibility.md`'s "hide third-party infra behind your own
abstraction" — if you want a different exposure mechanism later, this is the
one place to change).
