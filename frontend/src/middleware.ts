import { NextResponse, type NextRequest } from 'next/server';
import { safeReturnUrl } from '@/lib/live/token';

const API = process.env.API_INTERNAL_URL || 'http://localhost:4000';
/** Mirrors SESSION_COOKIE in apps/api/src/common/auth/auth.guard.ts. */
const SESSION_COOKIE = 'cf_session';

/**
 * Signed-in users skip the landing page and the login/signup forms. The cookie is checked against
 * the API (not just its presence) so a stale or revoked cookie doesn't bounce /login → /app → /login.
 * Any failure reaching the API falls through to the page.
 */
export async function middleware(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  if (!cookie) return NextResponse.next();

  let signedIn = false;
  try {
    const res = await fetch(`${API}/api/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    signedIn = res.ok;
  } catch {
    return NextResponse.next();
  }
  if (!signedIn) return NextResponse.next();

  const target = safeReturnUrl(req.nextUrl.searchParams.get('next')) ?? '/app';
  return NextResponse.redirect(new URL(target, req.url));
}

export const config = {
  matcher: ['/', '/login', '/signup'],
  runtime: 'nodejs',
};
