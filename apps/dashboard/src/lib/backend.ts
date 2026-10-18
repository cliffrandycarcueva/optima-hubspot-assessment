import 'server-only';

export async function backend(path: string, method = 'GET') {
  const origin = process.env.NESTJS_API_URL;
  const key = process.env.DASHBOARD_API_KEY;
  if (!origin || !key) throw new Error('Backend configuration unavailable');
  return fetch(new URL(path, origin), {
    method, headers: { Authorization: 'Bearer ' + key },
    cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(method === 'POST' ? 180000 : 10000),
  });
}
