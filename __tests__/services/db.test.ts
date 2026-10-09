import { connectionNeedsSsl } from '@/services/db';

// Option B correctness: a Supabase connection string (no explicit sslmode) must
// get TLS, while local Docker Postgres must not. An explicit sslmode always wins.
describe('connectionNeedsSsl', () => {
  it('enables SSL for a remote host with no sslmode param (Supabase)', () => {
    expect(
      connectionNeedsSsl(
        'postgresql://postgres:pw@db.abcxyz.supabase.co:5432/postgres',
      ),
    ).toBe(true);
  });

  it('disables SSL for loopback / docker hosts', () => {
    expect(
      connectionNeedsSsl('postgresql://agon:agon@127.0.0.1:5432/agon'),
    ).toBe(false);
    expect(
      connectionNeedsSsl('postgresql://agon:agon@localhost:5432/agon'),
    ).toBe(false);
    expect(connectionNeedsSsl('postgresql://agon:agon@db:5432/agon')).toBe(
      false,
    );
  });

  it('honors an explicit sslmode regardless of host', () => {
    expect(
      connectionNeedsSsl(
        'postgresql://u:p@127.0.0.1:5432/agon?sslmode=require',
      ),
    ).toBe(true);
    expect(
      connectionNeedsSsl(
        'postgresql://u:p@remote.example:5432/agon?sslmode=disable',
      ),
    ).toBe(false);
  });
});
