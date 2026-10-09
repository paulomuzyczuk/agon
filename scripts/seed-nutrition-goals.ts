import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import { loadEnv } from './loadEnv';
import { assertLocalTarget } from './seedGuard';
import { closeDbPool } from '../services/db';
import { upsertNutritionGoal } from '../services/nutritionGoals';
import { logger } from '../services/logger';

// Seed the modular `nutrition_goals` table from a PRIVATE config file — never
// from hardcoded values in this repo (nutrition decision 2026-08-24, same
// rationale as the Knowledge Vault Policy: this athlete's specific targets
// aren't checked into git; a new user drops their own copy of
// config/nutrition-goals.example.json at the configured path and re-runs this
// script — no code change).
//
// Path resolution: AGON_NUTRITION_GOALS_PATH if set, else
// config/nutrition-goals.local.json (gitignored — see .gitignore). Both are
// local paths (unlike the vault, which must live OUTSIDE the repo for copyright
// reasons); this file is just numbers, gitignore is enough belt-and-suspenders.
//
//   pnpm seed:nutrition-goals

const GoalSchema = z.object({
  goalKey: z.string().min(1),
  value: z.number().nonnegative(),
  unit: z.string().min(1),
  notes: z.string().nullable().optional(),
});
const GoalsFileSchema = z.array(GoalSchema);

function resolveGoalsPath(): string {
  return (
    process.env.AGON_NUTRITION_GOALS_PATH ||
    resolve(process.cwd(), 'config/nutrition-goals.local.json')
  );
}

async function main(): Promise<void> {
  loadEnv();
  assertLocalTarget('seed-nutrition-goals');

  const path = resolveGoalsPath();
  if (!existsSync(path)) {
    throw new Error(
      `seed-nutrition-goals: no goals file at ${path}. Copy ` +
        `config/nutrition-goals.example.json there (or point ` +
        `AGON_NUTRITION_GOALS_PATH at your own private copy) and fill in real values.`,
    );
  }

  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  const goals = GoalsFileSchema.parse(raw);

  for (const g of goals) {
    await upsertNutritionGoal(g);
  }
  logger.info('nutrition goals seeded', {
    job: 'seed-nutrition-goals',
    count: goals.length,
    path,
  });
  // eslint-disable-next-line no-console
  console.log(
    `\nSeeded ${goals.length} nutrition goal(s) from ${path}: ` +
      `${goals.map((g) => `${g.goalKey}=${g.value}${g.unit}`).join(', ')}.\n`,
  );
}

main()
  .catch((err) => {
    logger.error('seed-nutrition-goals failed', { job: 'seed-nutrition-goals' }, err);
    process.exitCode = 1;
  })
  .finally(() => closeDbPool());
