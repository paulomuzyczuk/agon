import { z } from 'zod';
import {
  jsonKeyPaths,
  missingHeadings,
  profileExampleProblems,
  schemaKeyPaths,
} from '../../scripts/checkExampleFiles';
import { AthleteProfileSchema } from '../../lib/athleteProfile';
import { readFileSync } from 'fs';
import { join } from 'path';

// MZY-400: the example files fell behind the real schema (no ftpHistory,
// vo2maxMeasured, time-trial sections). The check is the guard; it needs its
// own tests, including the failing cases.

const schema = z.object({
  tz: z.string(),
  ftp: z.array(z.object({ watts: z.number(), date: z.string() })).optional(),
  commute: z
    .object({ weekdays: z.array(z.number()), from: z.string() })
    .refine(() => true)
    .optional(),
  where: z.record(z.string(), z.string()).optional(),
});

const complete = {
  tz: 'UTC',
  ftp: [{ watts: 200, date: '2026-01-01' }],
  commute: { weekdays: [1], from: '2026-01-01' },
  where: { '5': 'Park' },
};

describe('schemaKeyPaths', () => {
  it('lists optional, nested and array-element keys; stops at records', () => {
    expect(schemaKeyPaths(schema).sort()).toEqual(
      [
        'commute',
        'commute.from',
        'commute.weekdays',
        'ftp',
        'ftp[].date',
        'ftp[].watts',
        'tz',
        'where',
      ].sort(),
    );
  });
});

describe('jsonKeyPaths', () => {
  it('merges the keys of every array element', () => {
    expect(jsonKeyPaths({ a: [{ b: 1 }, { c: 2 }] }).sort()).toEqual([
      'a',
      'a[].b',
      'a[].c',
    ]);
  });
});

describe('profileExampleProblems', () => {
  it('accepts an example holding every key, record data included', () => {
    expect(profileExampleProblems(schema, complete)).toEqual([]);
  });

  it('flags a missing optional top-level key', () => {
    const { ftp: _ftp, ...rest } = complete;
    expect(profileExampleProblems(schema, rest)).toEqual([
      'missing key: ftp',
      'missing key: ftp[].watts',
      'missing key: ftp[].date',
    ]);
  });

  it('flags a missing nested key', () => {
    expect(
      profileExampleProblems(schema, {
        ...complete,
        commute: { weekdays: [1] },
      }),
    ).toEqual(['missing key: commute.from']);
  });

  it('flags a key the schema does not read', () => {
    expect(profileExampleProblems(schema, { ...complete, stale: 1 })).toEqual([
      'unknown key (the schema does not read it): stale',
    ]);
  });
});

describe('missingHeadings', () => {
  const doc = [
    '## Parameters',
    '## Block 1 — Weeks 1–8',
    '## Block 2 — Weeks 9–16',
    '## Session library',
    '### Default calendar times',
    '## Time trials',
    '## Commutes',
    '## Further blocks',
  ].join('\n');

  it('accepts a doc with every required heading', () => {
    expect(missingHeadings(doc, 2)).toEqual([]);
  });

  it('names the heading that is missing, including blocks beyond the count present', () => {
    expect(
      missingHeadings(doc.replace('## Time trials', '## Trials'), 3),
    ).toEqual(['## Block 3 …', '## Time trials']);
  });

  it('does not accept Block 1 as a prefix of another heading', () => {
    expect(
      missingHeadings(doc.replace('## Block 1', '## Block 10'), 1),
    ).toEqual(['## Block 1 …']);
  });
});

describe('the committed example files', () => {
  it('match the real schema and program structure', () => {
    const example = JSON.parse(
      readFileSync(
        join(process.cwd(), 'config/athlete-profile.example.json'),
        'utf8',
      ),
    );
    expect(profileExampleProblems(AthleteProfileSchema, example)).toEqual([]);
    const doc = readFileSync(
      join(process.cwd(), 'docs/training-program.example.md'),
      'utf8',
    );
    expect(missingHeadings(doc, example.programBlockCount)).toEqual([]);
  });
});
