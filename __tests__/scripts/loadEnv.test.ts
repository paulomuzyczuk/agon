import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadEnv } from '../../scripts/loadEnv';

// scripts/loadEnv.ts is the tsx-scripts' own .env loader (Next.js has its
// own). Regression coverage for the inline-comment-stripping fix: a
// self-hoster copying .env.example's documentation-style `VAR=    # note`
// lines verbatim must get VAR left EMPTY, not set to the literal comment
// text (which would read as "configured" to every adapter's `if (!X)` check).

describe('loadEnv', () => {
  let dir: string;
  let originalCwd: string;
  const keys = ['AGON_TEST_BLANK_WITH_COMMENT', 'AGON_TEST_REAL_VALUE', 'AGON_TEST_HASH_NO_SPACE'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agon-loadenv-'));
    originalCwd = process.cwd();
    process.chdir(dir);
    for (const k of keys) delete process.env[k];
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    for (const k of keys) delete process.env[k];
  });

  it('leaves a documented-but-unfilled var empty rather than the comment text', () => {
    writeFileSync(
      join(dir, '.env.local'),
      'AGON_TEST_BLANK_WITH_COMMENT=            # secret — fill this in\n',
    );
    loadEnv();
    expect(process.env.AGON_TEST_BLANK_WITH_COMMENT).toBe('');
  });

  it('keeps a real filled-in value untouched', () => {
    writeFileSync(
      join(dir, '.env.local'),
      'AGON_TEST_REAL_VALUE=sk-abc123            # secret — some description\n',
    );
    loadEnv();
    expect(process.env.AGON_TEST_REAL_VALUE).toBe('sk-abc123');
  });

  it('only strips a comment preceded by whitespace, not a bare trailing #', () => {
    writeFileSync(join(dir, '.env.local'), 'AGON_TEST_HASH_NO_SPACE=abc#123\n');
    loadEnv();
    expect(process.env.AGON_TEST_HASH_NO_SPACE).toBe('abc#123');
  });
});
