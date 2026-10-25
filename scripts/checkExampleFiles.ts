import { readFileSync } from 'fs';
import { join } from 'path';
import type { ZodType } from 'zod';
import { AthleteProfileSchema } from '../lib/athleteProfile';

// Fails when the committed example files fall behind what the app reads, so a
// self-hoster who copies them gets every setting (MZY-400: the examples lacked
// ftpHistory, vo2maxMeasured and three program sections for weeks).
//
// config/athlete-profile.example.json: every key of the zod schema in
// lib/athleteProfile.ts, optional ones included, must be present, and no key
// the schema does not know may be. docs/training-program.example.md is NOT
// parsed by the app (lib/training/trainingProgram.ts is the machine's copy),
// so for it the check is only that the section headings a self-hoster is told
// to fill in exist. Update REQUIRED_HEADINGS when the doc's structure changes.

// Zod 4 internals (`def`) are the only way to walk a schema's shape; they are
// stable across 4.x but would need revisiting on a major bump.
interface Node {
  shape?: Record<string, ZodType>;
  def: { type: string; innerType?: ZodType; element?: ZodType };
}

/** Dotted key paths a schema reads: `commute.weekdays`, `ftpHistory[].watts`. Records stop at the record. */
export function schemaKeyPaths(schema: ZodType, prefix = ''): string[] {
  const node = schema as unknown as Node;
  const { type, innerType, element } = node.def;
  if (type === 'optional' && innerType)
    return schemaKeyPaths(innerType, prefix);
  if (type === 'array' && element)
    return schemaKeyPaths(element, `${prefix}[]`);
  if (type === 'object' && node.shape) {
    return Object.entries(node.shape).flatMap(([key, child]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      const nested = schemaKeyPaths(child, path);
      return nested.length > 0 ? [path, ...nested] : [path];
    });
  }
  return [];
}

/** Same path notation for a parsed JSON value. Arrays contribute the keys of every element. */
export function jsonKeyPaths(value: unknown, prefix = ''): string[] {
  const paths = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value)
      for (const p of jsonKeyPaths(item, `${prefix}[]`)) paths.add(p);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      paths.add(path);
      for (const p of jsonKeyPaths(child, path)) paths.add(p);
    }
  }
  return [...paths];
}

/** Problems comparing the example profile with the schema; empty when they match. */
export function profileExampleProblems(
  schema: ZodType,
  example: unknown,
): string[] {
  const wanted = new Set(schemaKeyPaths(schema));
  const present = new Set(jsonKeyPaths(example));
  // Keys under a leaf (e.g. the record timeTrialOutAndBack: "5" → place) are data, not schema keys.
  const leaves = [...wanted].filter(
    (k) =>
      ![...wanted].some((o) => o.startsWith(`${k}.`) || o.startsWith(`${k}[]`)),
  );
  const missing = [...wanted]
    .filter((k) => !present.has(k))
    .map((k) => `missing key: ${k}`);
  const unknown = [...present]
    .filter(
      (k) => !wanted.has(k) && !leaves.some((leaf) => k.startsWith(`${leaf}.`)),
    )
    .map((k) => `unknown key (the schema does not read it): ${k}`);
  return [...missing, ...unknown];
}

/** Headings the doc must contain: `programBlockCount` blocks, so the list follows the example's own profile. */
export function requiredHeadings(
  blockCount: number,
): { label: string; re: RegExp }[] {
  const blocks = Array.from({ length: blockCount }, (_, i) => ({
    label: `## Block ${i + 1} …`,
    re: new RegExp(`^## Block ${i + 1}\\b`, 'm'),
  }));
  return [
    { label: '## Parameters', re: /^## Parameters$/m },
    ...blocks,
    { label: '## Session library', re: /^## Session library$/m },
    {
      label: '### Default calendar times',
      re: /^### Default calendar times$/m,
    },
    { label: '## Time trials', re: /^## Time trials$/m },
    { label: '## Commutes', re: /^## Commutes$/m },
    { label: '## Further blocks', re: /^## Further blocks$/m },
  ];
}

/** Labels of the required headings the program doc lacks. */
export function missingHeadings(doc: string, blockCount: number): string[] {
  return requiredHeadings(blockCount)
    .filter(({ re }) => !re.test(doc))
    .map(({ label }) => label);
}

if (process.argv[1]?.endsWith('checkExampleFiles.ts')) {
  const root = process.cwd();
  const profilePath = 'config/athlete-profile.example.json';
  const docPath = 'docs/training-program.example.md';
  const problems: string[] = [];

  let profile: unknown;
  try {
    profile = JSON.parse(readFileSync(join(root, profilePath), 'utf8'));
  } catch (err) {
    console.error(
      `error: ${profilePath} is unreadable or not JSON: ${(err as Error).message}`,
    );
    process.exit(1);
  }
  for (const p of profileExampleProblems(AthleteProfileSchema, profile))
    problems.push(`${profilePath}: ${p}`);

  const blockCount = (profile as { programBlockCount?: unknown })
    .programBlockCount;
  if (
    typeof blockCount !== 'number' ||
    !Number.isInteger(blockCount) ||
    blockCount < 1
  ) {
    problems.push(
      `${profilePath}: programBlockCount must be a positive integer, got ${JSON.stringify(blockCount)}`,
    );
  } else {
    const doc = readFileSync(join(root, docPath), 'utf8');
    for (const h of missingHeadings(doc, blockCount))
      problems.push(`${docPath}: missing heading "${h}"`);
  }

  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    console.error(
      `error: ${problems.length} problem(s) in the example files. Add the missing keys/sections to the ` +
        'example (with a safe fictional value), or update scripts/checkExampleFiles.ts if the structure changed on purpose.',
    );
    process.exit(1);
  }
}
