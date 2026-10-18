// End-to-end scenarios for the n8n workflows against the local mock HubSpot (never real HubSpot).
// Prerequisites (see n8n/README.md): mock running, n8n started with OPTIMA_HUBSPOT_BASE_URL and
// OPTIMA_ALERT_WEBHOOK_URL pointing at the mock, both workflows imported, main workflow published.
//   node n8n/test/run-tests.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deliver, sampleOrder, sign, webhookSecret } from './lib.mjs';

const url = process.env.N8N_WEBHOOK_URL ?? 'http://localhost:5678/webhook/optima-order';
const mock = process.env.MOCK_HUBSPOT_URL ?? 'http://127.0.0.1:5680';
const secret = webhookSecret();
const ctl = async (path, body) => (await fetch(mock + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const faults = (list) => ctl('/__faults', list);
const state = () => ctl('/__state');
const id = (p) => p + '-' + randomUUID().slice(0, 8).toUpperCase();
const email = () => 'n8n-test-' + randomUUID().slice(0, 8) + '@example.com';
const count = (s, method, path) => s.calls.filter((c) => c.method === method && c.path === path).length;

const results = [];
async function scenario(name, fn) {
  const started = Date.now();
  try { await ctl('/__reset', {}); await fn(); results.push([name, 'PASS', Date.now() - started]); }
  catch (error) { results.push([name, 'FAIL: ' + error.message.split('\n')[0], Date.now() - started]); }
}

await scenario('1/4/6/9 valid signed order creates Contact, Deal and verified association', async () => {
  const o = sampleOrder(id('N8N'), email());
  const r = await deliver(url, o, { secret });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.result, 'synced'); assert.equal(r.body.order_id, o.order_id); assert.equal(r.body.dealReused, false);
  const s = await state();
  assert.equal(s.contacts.length, 1); assert.equal(s.deals.length, 1);
  const deal = s.deals[0];
  assert.deepEqual(deal.properties, { dealname: 'Order ' + o.order_id, amount: '900', closedate: '2026-09-20T06:32:00.000Z', pipeline: 'default', dealstage: 'appointmentscheduled', deal_currency_code: 'PHP', optima_order_id: o.order_id });
  assert.equal(r.body.dealId, deal.id); assert.equal(r.body.contactId, s.contacts[0].id);
  assert.ok(s.associations.includes(deal.id + ':' + s.contacts[0].id));
  assert.equal(count(s, 'POST', '/crm/v3/objects/contacts'), 1);
});

await scenario('2 invalid signature is rejected with 401 before any HubSpot call', async () => {
  const o = sampleOrder(id('N8N'), email());
  for (const signature of [sign(JSON.stringify(o), 'wrong-secret'), null, 'sha256=xyz']) {
    const r = await deliver(url, o, { secret, signature });
    assert.equal(r.status, 401); assert.deepEqual(r.body, { error: 'Invalid or missing signature' });
  }
  const body = JSON.stringify(o, null, 2); // signature over different bytes than sent
  assert.equal((await deliver(url, o, { secret, rawBody: body, signature: sign(JSON.stringify(o), secret) })).status, 401);
  assert.equal((await state()).calls.length, 0);
});

await scenario('3 missing required fields are rejected with 400', async () => {
  for (const mutate of [(o) => delete o.order_id, (o) => delete o.customer.email, (o) => (o.items = []), (o) => (o.total = 'x')]) {
    const o = sampleOrder(id('N8N'), email()); mutate(o);
    const r = await deliver(url, o, { secret });
    assert.equal(r.status, 400); assert.match(r.body.error, /^Invalid payload/);
  }
  // Malformed JSON never reaches the workflow: n8n's own body parser answers 422 first.
  const malformed = await deliver(url, null, { secret, rawBody: '{not json' });
  assert.equal(malformed.status, 422); assert.ok(!JSON.stringify(malformed.body).includes('stacktrace'), 'stack trace exposed');
  assert.equal((await state()).calls.length, 0);
});

await scenario('5 existing Contact is updated, not duplicated', async () => {
  const e = email();
  await deliver(url, sampleOrder(id('N8N'), e), { secret });
  const second = sampleOrder(id('N8N'), e); second.customer.first_name = 'Updated';
  const r = await deliver(url, second, { secret });
  assert.equal(r.status, 200);
  const s = await state();
  assert.equal(s.contacts.length, 1); assert.equal(s.contacts[0].properties.firstname, 'Updated');
  assert.equal(count(s, 'POST', '/crm/v3/objects/contacts'), 1);
  assert.ok(s.calls.some((c) => c.method === 'PATCH'));
  assert.equal(s.deals.length, 2);
});

await scenario('7 redelivery reuses the existing Deal', async () => {
  const o = sampleOrder(id('N8N'), email());
  const first = await deliver(url, o, { secret });
  const again = await deliver(url, o, { secret });
  assert.equal(again.status, 200); assert.equal(again.body.dealReused, true); assert.equal(again.body.dealId, first.body.dealId);
  const s = await state();
  assert.equal(s.deals.length, 1); assert.equal(count(s, 'POST', '/crm/v3/objects/deals'), 1);
});

await scenario('8 five simultaneous deliveries produce one Contact and one Deal', async () => {
  const o = sampleOrder(id('N8N'), email());
  const all = await Promise.all(Array.from({ length: 5 }, () => deliver(url, o, { secret })));
  assert.deepEqual(all.map((r) => r.status), [200, 200, 200, 200, 200], JSON.stringify(all.map((r) => r.body)));
  assert.equal(new Set(all.map((r) => r.body.dealId)).size, 1);
  assert.equal(new Set(all.map((r) => r.body.contactId)).size, 1);
  const s = await state();
  assert.equal(s.deals.length, 1); assert.equal(s.contacts.length, 1);
  assert.equal(s.associations.length, 1);
});

await scenario('10 HTTP 429 on Contact search is retried and succeeds', async () => {
  await faults([{ method: 'POST', path: '^/crm/v3/objects/contacts/search$', status: 429, times: 2, retryAfter: 1 }]);
  const r = await deliver(url, sampleOrder(id('N8N'), email()), { secret });
  assert.equal(r.status, 200);
  assert.equal(count(await state(), 'POST', '/crm/v3/objects/contacts/search'), 3);
});

await scenario('11a HTTP 500/503 on reads is retried and succeeds', async () => {
  await faults([{ method: 'POST', path: '^/crm/v3/objects/deals/search$', status: 503, times: 1 }, { method: 'GET', path: '/associations/contacts$', status: 500, times: 1 }]);
  const r = await deliver(url, sampleOrder(id('N8N'), email()), { secret });
  assert.equal(r.status, 200);
  const s = await state();
  assert.equal(count(s, 'POST', '/crm/v3/objects/deals/search'), 2);
});

await scenario('11b ambiguous 502 after Deal was created is reconciled without a duplicate', async () => {
  await faults([{ method: 'POST', path: '^/crm/v3/objects/deals$', status: 502, times: 1, afterCommit: true }]);
  const r = await deliver(url, sampleOrder(id('N8N'), email()), { secret });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.dealReused, true);
  const s = await state();
  assert.equal(s.deals.length, 1); assert.equal(r.body.dealId, s.deals[0].id);
});

await scenario('11c Contact create conflict (409) is reconciled by email lookup', async () => {
  await faults([{ method: 'POST', path: '^/crm/v3/objects/contacts$', status: 409, times: 1, afterCommit: true }]);
  const r = await deliver(url, sampleOrder(id('N8N'), email()), { secret });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = await state();
  assert.equal(s.contacts.length, 1); assert.equal(r.body.contactId, s.contacts[0].id);
  assert.ok(s.calls.some((c) => c.method === 'GET' && c.path.startsWith('/crm/v3/objects/contacts/')));
});

await scenario('12/13/14 HubSpot 401 fails the run, triggers the error workflow and sends a safe alert', async () => {
  await faults([{ path: '.*', status: 401, times: 999 }]);
  const o = sampleOrder(id('N8N'), email());
  const r = await deliver(url, o, { secret });
  assert.ok(r.status >= 500, 'expected a 5xx from n8n, got ' + r.status);
  assert.ok(!JSON.stringify(r.body).includes(o.customer.email));
  let alerts = [];
  for (let i = 0; i < 40 && alerts.length === 0; i++) { await new Promise((ok) => setTimeout(ok, 500)); alerts = await ctl('/__notifications'); }
  assert.equal(alerts.length, 1, 'expected one alert');
  const a = alerts[0];
  assert.equal(a.workflowName, 'Optima Order to HubSpot'); assert.equal(a.failedNode, 'Search Contact');
  assert.ok(a.executionId); assert.ok(a.timestamp); assert.equal(a.severity, 'error');
  const text = JSON.stringify(a);
  for (const leak of [o.customer.email, secret, 'Bearer ']) assert.ok(!text.includes(leak), 'alert leaked ' + (leak === secret ? 'secret' : leak));
  assert.equal(count(await state(), 'POST', '/crm/v3/objects/contacts/search'), 4, 'n8n retries every error up to maxTries');
});

console.log('\nn8n workflow scenarios');
for (const [name, outcome, ms] of results) console.log((outcome === 'PASS' ? '  ✔ ' : '  ✘ ') + name + ' — ' + outcome + ' (' + ms + ' ms)');
const failed = results.filter((r) => r[1] !== 'PASS').length;
console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
