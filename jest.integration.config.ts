import type { Config } from 'jest';

// Integration lane — exercises the migrations and write paths against a LIVE
// local Postgres (`pnpm db:up`, then `pnpm migrate`). This is the one place the
// unit suite structurally cannot reach: that the SQL DDL actually applies, the
// constraints bite, and the Strava upsert is genuinely idempotent against a
// real engine. Kept OUT of the fast unit suite (jest.config.ts
// testPathIgnorePatterns); costs seconds + Docker, so it runs only on demand.
//
// Prereq: `pnpm db:up`, a migrated `agon_test` DB (jest.integration.setup.ts
// — the lane never touches the real dev DB). Then: `pnpm test:integration`.
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testMatch: ['**/__tests__/integration/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }],
  },
  setupFiles: ['<rootDir>/jest.integration.setup.ts'],
  testTimeout: 30000,
  maxWorkers: 1, // serial: the suite shares one local database
  forceExit: true, // pg pool keeps a socket alive; nothing to drain on opt-in runs
};

export default config;
