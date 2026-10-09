import { validateReadOnlySql } from '@/services/mcp/sql';

// The read-only SQL gate. The READ ONLY transaction is the real write-guard;
// these check the first-line validation (single statement, SELECT/WITH only,
// no secret tables).

describe('validateReadOnlySql', () => {
  it('accepts a plain SELECT and strips a trailing semicolon', () => {
    const v = validateReadOnlySql('SELECT * FROM runs LIMIT 5;');
    expect(v.ok).toBe(true);
    expect(v.sql).toBe('SELECT * FROM runs LIMIT 5');
  });

  it('accepts a WITH (CTE) query', () => {
    expect(validateReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x').ok).toBe(
      true,
    );
  });

  it('is case- and whitespace-insensitive on the leading keyword', () => {
    expect(validateReadOnlySql('  \n  select 1').ok).toBe(true);
  });

  it('rejects non-SELECT statements', () => {
    for (const q of [
      'UPDATE runs SET distance_km = 0',
      'DELETE FROM runs',
      'DROP TABLE runs',
      'INSERT INTO runs (id) VALUES (1)',
      'TRUNCATE runs',
    ]) {
      const v = validateReadOnlySql(q);
      expect(v.ok).toBe(false);
      expect(v.error).toMatch(/read-only SELECT/);
    }
  });

  it('rejects multiple statements', () => {
    const v = validateReadOnlySql('SELECT 1; DROP TABLE runs');
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/single statement/);
  });

  it('rejects empty input', () => {
    expect(validateReadOnlySql('   ').ok).toBe(false);
  });

  it('denies reading OAuth token tables even via SELECT', () => {
    for (const q of [
      'SELECT * FROM google_calendar_oauth_tokens',
      'select refresh_token from public.google_health_oauth_tokens',
      'WITH t AS (SELECT * FROM google_health_oauth_tokens) SELECT * FROM t',
    ]) {
      const v = validateReadOnlySql(q);
      expect(v.ok).toBe(false);
      expect(v.error).toMatch(/not permitted/);
    }
  });
});
