import path from 'path';
import { resolveVaultPath } from '@/services/mcp/vault';

// The vault traversal guard — a model must not be able to read files outside the
// configured vault root through the vault tools.

const ROOT = '/home/athlete/agon-vault';

describe('resolveVaultPath', () => {
  it('resolves a plain page name and appends .md', () => {
    expect(resolveVaultPath(ROOT, 'vo2max')).toBe(path.join(ROOT, 'vo2max.md'));
  });

  it('keeps an explicit .md and allows subdirectories', () => {
    expect(resolveVaultPath(ROOT, 'running/vo2max.md')).toBe(
      path.join(ROOT, 'running/vo2max.md'),
    );
  });

  it('rejects parent-directory traversal', () => {
    for (const bad of [
      '../secrets',
      '../../etc/passwd',
      'running/../../escape',
      '..',
    ]) {
      expect(() => resolveVaultPath(ROOT, bad)).toThrow(
        /escapes the vault root/,
      );
    }
  });

  it('rejects an absolute path outside the root', () => {
    expect(() => resolveVaultPath(ROOT, '/etc/passwd')).toThrow(
      /escapes the vault root/,
    );
  });
});
