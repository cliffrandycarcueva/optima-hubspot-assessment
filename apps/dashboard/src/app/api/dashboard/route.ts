import { backend } from '@/lib/backend';
export const dynamic = 'force-dynamic';
export async function GET() {
  const [health, attempts] = await Promise.allSettled([backend('/health'), backend('/sync-attempts?limit=50')]);
  let connected = false;
  if (health.status === 'fulfilled' && health.value.ok) {
    const result = await health.value.json().catch(() => null);
    connected = result?.status === 'ok' && result?.database === 'connected';
  }
  if (attempts.status !== 'fulfilled' || !attempts.value.ok) {
    return Response.json({ connected, error: 'Unable to load synchronization history. Check that the API is running and dashboard access is configured.' }, { status: 503 });
  }
  const data = await attempts.value.json();
  return Response.json({ ...data, connected, checkedAt: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
}
