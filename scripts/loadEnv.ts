import { readFileSync } from 'fs';
import { resolve } from 'path';

// tsx doesn't auto-load .env files (Next does, but these scripts run outside
// Next). Mirrors the sihha loader: read .env.local first, then .env, and never
// clobber a variable already set in the real environment (so CI / shell exports
// win). Silent when a file is absent — the caller relies on the ambient env.
function apply(path: string): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf-8');
  } catch {
    return; // file absent — fine
  }
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let rawVal = trimmed.slice(eq + 1);
    // Strip a trailing inline comment (`VAR=            # explanatory note`,
    // the documentation style used throughout .env.example) — WITHOUT this,
    // a self-hoster who leaves an optional var's placeholder line untouched
    // gets that var set to the literal comment text instead of empty, which
    // reads as truthy/"configured" to every adapter's `if (!process.env.X)`
    // no-op check. Only strips a `#` preceded by whitespace, so a value that
    // legitimately contains `#` with no preceding space is left alone. Must
    // run BEFORE trimming — trimming first would erase the very whitespace
    // this match looks for.
    const commentMatch = rawVal.match(/\s#.*$/);
    if (commentMatch) rawVal = rawVal.slice(0, commentMatch.index);
    const val = rawVal.trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

export function loadEnv(): void {
  apply(resolve(process.cwd(), '.env.local'));
  apply(resolve(process.cwd(), '.env'));
}
