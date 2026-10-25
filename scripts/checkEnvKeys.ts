import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

// Fails when code reads process.env.<KEY> that .env.example never mentions, so a
// self-hoster can discover every setting (MZY-400: AGON_BACKUP_DIR and others were
// read by scripts for months without being listed). A key counts as documented when
// it appears as `KEY=` in .env.example, commented out or not.
// Not detected: dynamic reads such as process.env[name].

/** Keys that are deliberately not in .env.example, each with the reason. */
export const ALLOWED_UNDOCUMENTED: { match: RegExp; why: string }[] = [
  { match: /^NODE_ENV$/, why: 'set by Node, Next.js and the test runner, never by the operator' },
  { match: /_AUTH_CODE$/, why: 'one-time OAuth code, passed as a CLI argument to the *:auth scripts' },
];

const KEY_READ = /process\.env\.([A-Z][A-Z0-9_]*)/g;
const COMMENT_LINE = /^\s*(\/\/|\/?\*)/;

/** First read of each env key per file set: key → "file:line". Comment-only lines are skipped. */
export function collectEnvReads(files: Record<string, string>): Map<string, string> {
  const reads = new Map<string, string>();
  for (const [file, text] of Object.entries(files)) {
    text.split('\n').forEach((line, i) => {
      if (COMMENT_LINE.test(line)) return;
      for (const m of line.matchAll(KEY_READ)) {
        if (!reads.has(m[1]!)) reads.set(m[1]!, `${file}:${i + 1}`);
      }
    });
  }
  return reads;
}

/** Keys named as `KEY=` in the example file, commented out or not. */
export function documentedKeys(example: string): Set<string> {
  const keys = new Set<string>();
  for (const m of example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) keys.add(m[1]!);
  return keys;
}

/** Keys the code reads that the example neither documents nor allows, with where they are read. */
export function undocumentedEnvKeys(files: Record<string, string>, example: string): [string, string][] {
  const documented = documentedKeys(example);
  return [...collectEnvReads(files)]
    .filter(([key]) => !documented.has(key) && !ALLOWED_UNDOCUMENTED.some((a) => a.match.test(key)))
    .sort(([a], [b]) => a.localeCompare(b));
}

const SOURCE_ROOTS = ['app', 'lib', 'services', 'scripts', 'components', 'middleware.ts'];

function sourceFiles(root: string, path: string, out: Record<string, string>): void {
  const abs = join(root, path);
  if (!existsSync(abs)) return;
  if (statSync(abs).isDirectory()) {
    for (const entry of readdirSync(abs)) sourceFiles(root, join(path, entry), out);
  } else if (/\.(ts|tsx|mjs)$/.test(path)) {
    out[relative(root, abs)] = readFileSync(abs, 'utf8');
  }
}

if (process.argv[1]?.endsWith('checkEnvKeys.ts')) {
  const root = process.cwd();
  const files: Record<string, string> = {};
  for (const r of SOURCE_ROOTS) sourceFiles(root, r, files);
  const missing = undocumentedEnvKeys(files, readFileSync(join(root, '.env.example'), 'utf8'));
  if (missing.length > 0) {
    for (const [key, where] of missing) console.error(`${key}  (read at ${where})`);
    console.error(
      `error: ${missing.length} env var(s) read by the code but absent from .env.example. ` +
        'Add each as a commented-out `# KEY=` line with a one-line description, or, if it is ' +
        'deliberately internal, add it to ALLOWED_UNDOCUMENTED in scripts/checkEnvKeys.ts with the reason.',
    );
    process.exit(1);
  }
}
