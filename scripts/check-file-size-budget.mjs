// File-size fitness function (copied from the sihha benchmark, CLAUDE.md
// "Guard-rails worth copying"). Keeps files small enough to read in one sitting;
// splitting is cheaper before a file grows a second responsibility than after.
//   - components/**                        → 800 hard lines (React earns slack)
//   - app/, lib/, services/, scripts/      → 500 hard lines
//
// EXEMPTIONS is a RATCHET, not a pardon: a legacy over-cap file is frozen at its
// current line count and may only shrink. When it drops under its cap the script
// demands the entry be deleted, so the list can never quietly regrow.
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';

const COMPONENT_HARD_CAP = 800;
const DEFAULT_HARD_CAP = 500;
const SCANNED_DIRS = ['app', 'components', 'lib', 'services', 'scripts'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mjs'];

// file → frozen ceiling (its line count when the gate landed). Each entry may
// only go DOWN; the script demands its removal once the file is under its cap.
const EXEMPTIONS = {
  'lib/movingTime.ts': 555,
  'services/routing/generate.ts': 515,
};

function sourceFiles(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      found.push(path);
    }
  }
  return found;
}

function lineCount(path) {
  return (readFileSync(path, 'utf-8').match(/\n/g) ?? []).length;
}

function capFor(path) {
  return path.startsWith('components/') ? COMPONENT_HARD_CAP : DEFAULT_HARD_CAP;
}

const failures = [];
const staleExemptions = [];
const seen = new Set();

for (const dir of SCANNED_DIRS) {
  for (const path of sourceFiles(dir)) {
    seen.add(path);
    const lines = lineCount(path);
    const cap = capFor(path);
    const ceiling = EXEMPTIONS[path];

    if (ceiling !== undefined) {
      if (lines > ceiling) {
        failures.push(
          `${path}: ${lines} lines — exempted legacy file GREW past its frozen ceiling of ${ceiling} (ratchet only goes down; split it or shrink the change)`,
        );
      } else if (lines <= cap) {
        staleExemptions.push(
          `${path}: now ${lines} lines (cap ${cap}) — delete its EXEMPTIONS entry in scripts/check-file-size-budget.mjs`,
        );
      }
    } else if (lines > cap) {
      failures.push(
        `${path}: ${lines} lines exceeds the ${cap}-line hard cap — split it before adding logic`,
      );
    }
  }
}

for (const path of Object.keys(EXEMPTIONS)) {
  if (!seen.has(path)) {
    staleExemptions.push(
      `${path}: no longer exists — delete its EXEMPTIONS entry`,
    );
  }
}

if (failures.length > 0 || staleExemptions.length > 0) {
  for (const message of [...failures, ...staleExemptions]) {
    console.error(`check-file-size-budget: ${message}`);
  }
  process.exit(2);
}

console.log(
  `check-file-size-budget: ${seen.size} files within caps (${Object.keys(EXEMPTIONS).length} frozen exemptions)`,
);
