import { config } from 'dotenv';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

async function main() {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || !secret.trim()) throw new Error();
  const orderId = process.argv[2] ?? 'ORD-10482';
  const payload = {
    event: 'order.created',
    order_id: orderId,
    created_at: '2026-09-20T14:32:00+08:00',
    customer: {
      email: 'maria.santos@example.com',
      first_name: 'Maria',
      last_name: 'Santos',
      phone: '+639171234567',
    },
    items: [{ sku: 'TSH-BLK-M', name: 'Black Tee (M)', qty: 2, price: 450 }],
    currency: 'PHP',
    total: 900,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  const port = Number(process.env.PORT ?? '3000');
  const response = await fetch('http://127.0.0.1:' + port + '/webhooks/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(180000),
  });
  console.log('HTTP ' + response.status);
  const result = await response.json();
  // Print only the endpoint's outcome, never headers, secret, or original payload.
  console.log(JSON.stringify({ result: result.result ?? 'rejected' }));
  if (!response.ok) process.exitCode = 1;
}

main().catch(() => {
  console.error('Sample webhook failed. Check the local server, PORT, and WEBHOOK_SECRET.');
  process.exitCode = 1;
});
