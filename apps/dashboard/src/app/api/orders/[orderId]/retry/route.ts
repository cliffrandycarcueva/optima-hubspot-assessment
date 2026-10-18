import { backend } from '@/lib/backend';
export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  // Basic-auth cookies/credentials may be attached cross-site; reject cross-site mutations.
  if (request.headers.get('origin') !== (process.env.DASHBOARD_ORIGIN ?? 'http://localhost:3000')) {
    return Response.json({ message: 'Request origin is not allowed' }, { status: 403 });
  }
  const { orderId } = await params;
  if (!orderId || orderId.length > 200) return Response.json({ message: 'Invalid order ID' }, { status: 400 });
  try {
    const response = await backend('/orders/' + encodeURIComponent(orderId) + '/retry', 'POST');
    const data = await response.json().catch(() => null);
    const messages: Record<number, string> = {
      401: 'Dashboard API access was rejected.',
      404: 'This order no longer exists.',
      409: 'This order is no longer eligible or is already being retried. Refresh to see its current state.',
      503: 'Synchronization failed. Refresh the history to inspect the recorded error.',
    };
    return Response.json(response.ok ? data : { message: messages[response.status] ?? 'Retry could not be completed.' }, { status: response.status });
  } catch {
    return Response.json({ message: 'The API did not respond. The retry may still be running; refresh before trying again.' }, { status: 503 });
  }
}
