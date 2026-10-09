/* Agon service worker (MZY-207) — the offline shell.
 *
 * Hand-rolled (no Workbox/Serwist): a few dozen lines of fetch strategies,
 * in the same spirit as the hand-rolled outbox + pull (MZY-28 decision 4).
 * It never touches athlete data semantics — the device replica lives in
 * IndexedDB (lib/sync/replica.ts); this only keeps pages and reads openable
 * without a network.
 *
 *   navigations      network-first, cached copy offline (/nutrition, /health
 *                    and /record are precached with their JS/CSS on install)
 *   /_next/static/*  cache-first — content-hashed, immutable
 *   GET /api/*       network-first, cached copy offline: the read-through
 *                    for ingested data (runs, streams, marts) and reference
 *                    data (goals, foods). Never: /api/sync/* and /api/auth/*.
 *   RSC fetches      network-first (client-side navigation payloads)
 *
 * Only 200, non-redirected responses are cached, so a login redirect after
 * a session expires is never stored as a page. Bump VERSION to drop caches.
 */
const VERSION = 'agon-v1';
const PAGES = `${VERSION}-pages`;
const STATIC = `${VERSION}-static`;
const API = `${VERSION}-api`;
const SHELL = ['/', '/nutrition', '/health', '/record'];

function cacheable(res) {
  return res && res.ok && res.status === 200 && !res.redirected && res.type === 'basic';
}

async function precacheShell() {
  const pages = await caches.open(PAGES);
  const statics = await caches.open(STATIC);
  for (const path of SHELL) {
    try {
      const res = await fetch(path, { credentials: 'same-origin' });
      if (!cacheable(res)) continue; // signed out: nothing to cache yet
      await pages.put(path, res.clone());
      const html = await res.text();
      const assets = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]);
      await Promise.all(
        [...new Set(assets)].map((a) =>
          statics.match(a).then((hit) => hit || statics.add(a).catch(() => undefined)),
        ),
      );
    } catch {
      // Offline during install: the runtime strategies fill the caches later.
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().then(() => self.skipWaiting()));
});

// The page asks for this after every successful sync — i.e. when it is
// certainly signed in. Install-time precaching alone is not enough: the SW
// is often installed from /login, where every shell page still redirects.
self.addEventListener('message', (event) => {
  if (event.data === 'precache') event.waitUntil(precacheShell());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request, cacheName, key) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (cacheable(res)) await cache.put(key || request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key || request);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (cacheable(res)) await cache.put(request, res.clone());
  return res;
}

function offlinePage() {
  return new Response(
    '<!doctype html><meta name="viewport" content="width=device-width"><body style="background:#0a0a0a;color:#e7e9ec;font-family:system-ui;padding:2rem">' +
      '<h1>Offline</h1><p>This page hasn’t been opened on this device yet. Nutrition, health and record work offline once visited.</p></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.startsWith('/api/sync/') || path.startsWith('/api/auth/') || path === '/sw.js') return;

  if (request.mode === 'navigate') {
    // Keyed by path: one cached copy per page, whatever the query string.
    event.respondWith(networkFirst(request, PAGES, path).catch(() => offlinePage()));
  } else if (path.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request));
  } else if (path.startsWith('/api/')) {
    event.respondWith(networkFirst(request, API));
  } else if (request.headers.get('RSC') === '1') {
    event.respondWith(networkFirst(request, PAGES));
  }
});
