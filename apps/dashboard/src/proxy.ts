import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';

export function proxy(request: NextRequest) {
  const username = process.env.DASHBOARD_USERNAME;
  const password = process.env.DASHBOARD_PASSWORD;
  if (!username || !password || password.length < 16) {
    return new NextResponse('Dashboard login is not configured.', { status: 503 });
  }
  const auth = request.headers.get('authorization') ?? '';
  const expected = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  const hash = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(hash(auth), hash(expected))) {
    return new NextResponse('Sign in with the local dashboard credentials.', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Optima dashboard", charset="UTF-8"', 'Cache-Control': 'no-store' },
    });
  }
  return NextResponse.next();
}
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
