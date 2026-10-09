import { ClientWriteMetaSchema, deriveUuid } from '@/services/clientWrite';

describe('deriveUuid', () => {
  const base = '6f1c2e0a-4b7d-4c1e-9a55-0d3f8b2c7e11';

  it('is deterministic — a replay derives the same row ids', () => {
    expect(deriveUuid(base, 'breakfast')).toBe(deriveUuid(base, 'breakfast'));
  });

  it('differs per name and per base', () => {
    expect(deriveUuid(base, 'breakfast')).not.toBe(deriveUuid(base, 'lunch'));
    expect(deriveUuid(base, 'breakfast')).not.toBe(
      deriveUuid('0b9a7d3e-1111-4222-8333-444455556666', 'breakfast'),
    );
  });

  it('is a valid RFC 4122 v5 UUID (accepted by the uuid column and zod)', () => {
    const id = deriveUuid(base, 'snack');
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('matches the RFC 4122 v5 reference (DNS namespace, "python.org")', () => {
    // Python: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
    expect(
      deriveUuid('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org'),
    ).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });
});

describe('ClientWriteMetaSchema', () => {
  it('accepts a device-stamped write and legacy writes without meta', () => {
    expect(
      ClientWriteMetaSchema.parse({
        mode: 'adhoc',
        clientId: '6f1c2e0a-4b7d-4c1e-9a55-0d3f8b2c7e11',
        capturedAt: '2026-03-01T22:30:00.000Z',
      }),
    ).toEqual({
      clientId: '6f1c2e0a-4b7d-4c1e-9a55-0d3f8b2c7e11',
      capturedAt: '2026-03-01T22:30:00.000Z',
    });
    expect(ClientWriteMetaSchema.parse({ mode: 'adhoc' })).toEqual({});
  });

  it('rejects a capturedAt without a zone (ambiguous instant)', () => {
    expect(
      ClientWriteMetaSchema.safeParse({ capturedAt: '2026-03-01T22:30:00' })
        .success,
    ).toBe(false);
  });
});
