import type { Config } from 'jest';

// Fast unit lane. Pure logic only — mappers, OAuth/refresh decisions, the
// Strava HTTP client (with fetch mocked), training-block math, the seed guard.
// Anything needing a live Postgres lives in the integration lane below and is
// explicitly excluded here so `pnpm test` stays in milliseconds.
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/integration/'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }],
  },
  setupFiles: ['<rootDir>/jest.setup.ts'],
};

export default config;
