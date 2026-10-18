// Shared helpers: signing with the same convention as the NestJS receiver, and secret lookup.
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** OPTIMA_WEBHOOK_SECRET from the environment, else WEBHOOK_SECRET from the repository root .env. Never printed. */
export function webhookSecret() {
  if (process.env.OPTIMA_WEBHOOK_SECRET?.trim()) return process.env.OPTIMA_WEBHOOK_SECRET.trim();
  const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*WEBHOOK_SECRET\s*=\s*(.*?)\s*$/);
      if (m && m[1]) return m[1].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  throw new Error('Set OPTIMA_WEBHOOK_SECRET (or WEBHOOK_SECRET in the root .env).');
}

export const sign = (body, secret) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

export function sampleOrder(orderId, email) {
  return {
    event: 'order.created',
    order_id: orderId,
    created_at: '2026-09-20T14:32:00+08:00',
    customer: { email, first_name: 'Test', last_name: 'Customer', phone: '+639170000000' },
    items: [{ sku: 'TSH-BLK-M', name: 'Black Tee (M)', qty: 2, price: 450 }],
    currency: 'PHP',
    total: 900,
  };
}

export async function deliver(url, order, { secret, signature, rawBody } = {}) {
  const body = rawBody ?? JSON.stringify(order);
  const headers = { 'Content-Type': 'application/json' };
  const sig = signature === undefined ? sign(body, secret) : signature;
  if (sig !== null) headers['X-Webhook-Signature'] = sig;
  const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(120000) });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: response.status, body: json };
}
