import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth/cookie';

// POST /api/auth/logout — clears the session cookie.
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
