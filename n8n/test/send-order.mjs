// Sends one signed order.created webhook to the n8n workflow.
//   node n8n/test/send-order.mjs <ORDER_ID> <customer-email> [webhook-url]
// Default URL: http://localhost:5678/webhook/optima-order (production URL of the published workflow).
// Use synthetic emails only. Against real HubSpot this creates/updates a real Contact and Deal.
import { deliver, sampleOrder, webhookSecret } from './lib.mjs';

const [orderId, email, url = process.env.N8N_WEBHOOK_URL ?? 'http://localhost:5678/webhook/optima-order'] = process.argv.slice(2);
if (!orderId || !email) {
  console.error('Usage: node n8n/test/send-order.mjs <ORDER_ID> <customer-email> [webhook-url]');
  process.exit(2);
}
const result = await deliver(url, sampleOrder(orderId, email), { secret: webhookSecret() });
console.log('HTTP ' + result.status);
console.log(JSON.stringify(result.body));
process.exitCode = result.status === 200 ? 0 : 1;
