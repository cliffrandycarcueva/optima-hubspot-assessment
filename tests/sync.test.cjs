const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHmac } = require('node:crypto');
process.env.WEBHOOK_SECRET = 'isolated-webhook-test-secret';
process.env.HUBSPOT_ACCESS_TOKEN = 'mock-token';
process.env.HUBSPOT_PIPELINE_ID = 'test-pipeline';
process.env.HUBSPOT_DEAL_STAGE_ID = 'test-stage';
process.env.HUBSPOT_ORDER_ID_PROPERTY = 'optima_order_id';
// These tests check single-attempt failure recording; retry behavior is covered in retry.test.cjs.
process.env.HUBSPOT_RETRY_MAX_ATTEMPTS = '1';
// Schedule any automatic retry a day ahead so no scheduler (including a running dev API
// on the same database) picks up test rows before cleanup.
process.env.SYNC_AUTO_RETRY_INITIAL_DELAY_MS = '86400000';
process.env.SYNC_AUTO_RETRY_MAX_DELAY_MS = '86400000';
const { createApplication } = require('../dist/application');
const { OrderSyncService } = require('../dist/sync/order-sync.service');
const source = require('../dist/database/data-source').default;

test('HubSpot orchestration with mocked HTTP and real PostgreSQL', async (t) => {
  const nativeFetch = global.fetch;
  const contacts = new Map(), deals = new Map(), associations = new Set();
  const calls = [];
  let sequence = 100;
  let fault = null, createTimeout = false, contactConflict = false, dealConflict = false, hideAssociation = false;
  let unique = true, enabledCurrency = true, writeScope = true;
  function json(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers });
  }
  global.fetch = async (input, options = {}) => {
    if (!String(input).startsWith('https://api.hubapi.com/')) return nativeFetch(input, options);
    const url = new URL(input), method = options.method ?? 'GET', path = url.pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method, body });
    if (fault && fault(method, path)) {
      const status = fault.status ?? 500; fault = null;
      return json({ message: 'SECRET_RESPONSE_MUST_NOT_LEAK', category: 'ERROR' }, status, { 'retry-after': '30' });
    }
    if (path === '/oauth/v2/private-apps/get/access-token-info') return json({ scopes: [
      'crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.deals.read',
      ...(writeScope ? ['crm.objects.deals.write'] : []),
    ] });
    if (path === '/crm/v3/properties/deals/optima_order_id') return json({ hasUniqueValue: unique, type: 'string' });
    if (path === '/crm/v3/pipelines/deals/test-pipeline') return json({ stages: [{ id: 'test-stage' }] });
    if (path === '/account-info/v3/details') return json({ companyCurrency: enabledCurrency ? 'PHP' : 'USD', additionalCurrencies: [] });
    if (path.endsWith('/contacts/search')) {
      const contact = contacts.get(body.filterGroups[0].filters[0].value);
      return json({ results: contact ? [contact] : [] });
    }
    if (path.startsWith('/crm/v3/objects/contacts/') && method === 'GET') {
      const contact = contacts.get(decodeURIComponent(path.split('/').at(-1)));
      return contact ? json(contact) : json({}, 404);
    }
    if (path === '/crm/v3/objects/contacts' && method === 'POST') {
      const record = { id: String(++sequence), properties: body.properties };
      contacts.set(body.properties.email, record);
      if (contactConflict) { contactConflict = false; return json({}, 409); }
      return json(record, 201);
    }
    if (path.startsWith('/crm/v3/objects/contacts/') && method === 'PATCH') {
      const record = [...contacts.values()].find(c => c.id === path.split('/').at(-1));
      assert.ok(record); record.properties = body.properties; return json(record);
    }
    if (path.startsWith('/crm/v3/objects/deals/') && method === 'GET') {
      const record = deals.get(decodeURIComponent(path.split('/').at(-1)));
      return record ? json(record) : json({}, 404);
    }
    if (path === '/crm/v3/objects/deals' && method === 'POST') {
      const key = body.properties.optima_order_id;
      if (deals.has(key)) return json({}, 409);
      const record = { id: String(++sequence), properties: body.properties };
      deals.set(key, record);
      if (createTimeout) { createTimeout = false; throw new DOMException('timeout', 'TimeoutError'); }
      if (dealConflict) { dealConflict = false; return json({}, 409); }
      return json(record, 201);
    }
    if (path.includes('/associations/default/contacts/') && method === 'PUT') {
      const bits = path.split('/'); associations.add(bits[5] + ':' + bits.at(-1));
      return json({});
    }
    if (path.endsWith('/associations/contacts') && method === 'GET') {
      const id = path.split('/')[5];
      return json({ results: hideAssociation ? [] : [...associations].filter(a => a.startsWith(id + ':'))
        .map(a => ({ toObjectId: a.split(':')[1] })) });
    }
    throw new Error('Unexpected mock request: ' + method + ' ' + path);
  };

  const app = await createApplication();
  const ids = [];
  t.after(async () => {
    global.fetch = nativeFetch;
    try {
      await source.query('DELETE FROM public.sync_attempts WHERE order_id = ANY($1::text[])', [ids]);
      await source.query('DELETE FROM public.orders WHERE order_id = ANY($1::text[])', [ids]);
    } finally { await app.close(); }
  });
  await app.listen(0, '127.0.0.1');
  const sync = app.get(OrderSyncService);
  const url = await app.getUrl() + '/webhooks/orders';
  function payload() {
    const order_id = 'sync-test-' + randomUUID(); ids.push(order_id);
    return { event: 'order.created', order_id, created_at: '2026-09-20T14:32:00+08:00',
      customer: { email: randomUUID() + '@example.com', first_name: 'Maria', last_name: 'Santos' },
      items: [{ sku: 'A', name: 'Item', qty: 1, price: 900 }], currency: 'PHP', total: 900 };
  }
  async function seed(p = payload()) {
    await source.query('INSERT INTO public.orders (order_id, payload) VALUES ($1, $2::jsonb)', [p.order_id, JSON.stringify(p)]);
    return p;
  }
  async function state(id) {
    const [order] = await source.query('SELECT * FROM public.orders WHERE order_id=$1', [id]);
    const attempts = await source.query('SELECT * FROM public.sync_attempts WHERE order_id=$1 ORDER BY id', [id]);
    return { order, attempts };
  }
  function countCreates(object) { return calls.filter(c => c.method === 'POST' && c.path === '/crm/v3/objects/' + object).length; }
  async function webhook(p) {
    const body = JSON.stringify(p), signature = 'sha256=' + createHmac('sha256', process.env.WEBHOOK_SECRET).update(body).digest('hex');
    const response = await nativeFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature }, body });
    return { status: response.status, body: await response.json() };
  }

  await t.test('creates Contact, Deal, verifies association and records success', async () => {
    const p = await seed();
    assert.deepEqual(await sync.synchronize(p.order_id), { status: 'synced' });
    const { order, attempts } = await state(p.order_id);
    assert.equal(order.status, 'synced'); assert.ok(order.synced_at);
    assert.equal(order.last_error, null);
    assert.equal(attempts.length, 1); assert.equal(attempts[0].status, 'succeeded');
    assert.ok(attempts[0].finished_at); assert.equal(attempts[0].hubspot_deal_id, order.hubspot_deal_id);
    assert.ok(associations.has(order.hubspot_deal_id + ':' + order.hubspot_contact_id));
    const deal = deals.get(p.order_id);
    assert.equal(deal.properties.amount, '900'); assert.equal(deal.properties.deal_currency_code, 'PHP');
    assert.equal(deal.properties.pipeline, 'test-pipeline'); assert.equal(deal.properties.dealstage, 'test-stage');
    assert.equal(deal.properties.closedate, '2026-09-20T06:32:00.000Z');
    const before = calls.length;
    assert.deepEqual(await sync.synchronize(p.order_id), { status: 'synced', skipped: true });
    assert.equal(calls.length, before); assert.equal((await state(p.order_id)).attempts.length, 1);
  });

  await t.test('updates existing Contact across orders instead of creating another', async () => {
    const p = await seed(); const existing = { id: String(++sequence), properties: { email: p.customer.email } };
    contacts.set(p.customer.email, existing); const before = countCreates('contacts');
    await sync.synchronize(p.order_id);
    assert.equal(countCreates('contacts'), before); assert.equal(existing.properties.firstname, 'Maria');
    assert.equal((await state(p.order_id)).order.hubspot_contact_id, existing.id);
  });

  await t.test('reconciles concurrent Contact create conflict by email', async () => {
    const p = await seed(); contactConflict = true;
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
    assert.equal((await state(p.order_id)).order.hubspot_contact_id, contacts.get(p.customer.email).id);
  });

  await t.test('finds an existing unique Deal after a crash before local ID save', async () => {
    const p = await seed();
    deals.set(p.order_id, { id: String(++sequence), properties: { optima_order_id: p.order_id } });
    const before = countCreates('deals');
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
    assert.equal(countCreates('deals'), before);
  });

  await t.test('recovers ambiguous create timeout without a second Deal', async () => {
    const p = await seed(); createTimeout = true;
    assert.equal((await sync.synchronize(p.order_id)).status, 'failed');
    let s = await state(p.order_id);
    assert.ok(s.order.hubspot_contact_id); assert.equal(s.order.hubspot_deal_id, null);
    assert.match(s.order.last_error, /network_or_timeout/);
    const before = countCreates('deals');
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
    assert.equal(countCreates('deals'), before);
    s = await state(p.order_id);
    assert.deepEqual(s.attempts.map(a => a.status), ['failed', 'succeeded']);
  });

  await t.test('retains Deal ID after association failure and reuses it on retry', async () => {
    const p = await seed(); fault = (m, path) => m === 'PUT';
    assert.equal((await sync.synchronize(p.order_id)).status, 'failed');
    const failed = await state(p.order_id);
    assert.ok(failed.order.hubspot_deal_id); assert.equal(failed.order.synced_at, null);
    assert.equal(failed.attempts[0].hubspot_deal_id, failed.order.hubspot_deal_id);
    assert.ok(!failed.order.last_error.includes('SECRET_RESPONSE'));
    const before = countCreates('deals');
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
    assert.equal(countCreates('deals'), before);
    assert.equal((await state(p.order_id)).attempts.length, 2);
  });

  await t.test('requires read-back confirmation of association', async () => {
    const p = await seed(); hideAssociation = true;
    assert.equal((await sync.synchronize(p.order_id)).status, 'failed');
    hideAssociation = false;
    assert.match((await state(p.order_id)).order.last_error, /association_not_verified/);
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
  });

  for (const status of [400, 401, 403, 429, 500, 503]) {
    await t.test('records HTTP ' + status + ' without leaking response bodies', async () => {
      const p = await seed(); fault = (m, path) => path.endsWith('/contacts/search'); fault.status = status;
      assert.equal((await sync.synchronize(p.order_id)).status, 'failed');
      const { order, attempts } = await state(p.order_id);
      assert.match(order.last_error, new RegExp('HTTP ' + status));
      assert.ok(!order.last_error.includes('SECRET_RESPONSE'));
      assert.equal(attempts[0].status, 'failed'); assert.ok(attempts[0].finished_at);
      if (status === 429) assert.match(order.last_error, /Retry-After=30/);
    });
  }

  await t.test('reconciles a remote unique Deal conflict', async () => {
    const p = await seed(); dealConflict = true;
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
    assert.equal((await state(p.order_id)).order.hubspot_deal_id, deals.get(p.order_id).id);
  });

  await t.test('concurrent workers make one attempt and one Deal', async () => {
    const p = await seed(); const before = countCreates('deals');
    const results = await Promise.all(Array.from({ length: 8 }, () => sync.synchronize(p.order_id)));
    assert.ok(results.some(r => r.status === 'synced'));
    assert.equal((await state(p.order_id)).attempts.length, 1);
    assert.equal(countCreates('deals') - before, 1);
  });

  await t.test('recovers abandoned processing attempt after restart', async () => {
    const p = await seed();
    await source.query("UPDATE public.orders SET status='processing' WHERE order_id=$1", [p.order_id]);
    await source.query("INSERT INTO public.sync_attempts (order_id) VALUES ($1)", [p.order_id]);
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
    const s = await state(p.order_id);
    assert.deepEqual(s.attempts.map(a => a.status), ['failed', 'succeeded']);
    assert.match(s.attempts[0].error, /Interrupted/);
  });

  await t.test('webhook triggers sync once and concurrent duplicates do not resync', async () => {
    const p = payload(), before = countCreates('deals');
    const responses = await Promise.all(Array.from({ length: 6 }, () => webhook(p)));
    assert.equal(responses.filter(r => r.status === 201).length, 1);
    assert.equal(responses.filter(r => r.status === 200).length, 5);
    assert.equal((await state(p.order_id)).order.status, 'synced');
    assert.equal((await state(p.order_id)).attempts.length, 1);
    assert.equal(countCreates('deals') - before, 1);
  });

  await t.test('unsafe configuration fails before any Contact or Deal writes', async () => {
    const p = await seed(), before = countCreates('contacts');
    unique = false; assert.equal((await sync.synchronize(p.order_id)).status, 'failed'); unique = true;
    enabledCurrency = false; assert.equal((await sync.synchronize(p.order_id)).status, 'failed'); enabledCurrency = true;
    assert.equal(countCreates('contacts'), before);
    assert.match((await state(p.order_id)).order.last_error, /currency_not_enabled/);
    writeScope = false; assert.equal((await sync.synchronize(p.order_id)).status, 'failed'); writeScope = true;
    assert.equal(countCreates('contacts'), before);
    assert.match((await state(p.order_id)).order.last_error, /missing_scopes:crm.objects.deals.write/);
  });

  await t.test('Contact update failure preserves the known Contact ID', async () => {
    const p = await seed(), id = String(++sequence);
    contacts.set(p.customer.email, { id, properties: { email: p.customer.email } });
    fault = (m, path) => m === 'PATCH' && path.includes('/contacts/');
    assert.equal((await sync.synchronize(p.order_id)).status, 'failed');
    const s = await state(p.order_id);
    assert.equal(s.order.hubspot_contact_id, id);
    assert.equal(s.attempts[0].hubspot_contact_id, id);
    assert.equal(s.order.hubspot_deal_id, null);
  });

  for (const object of ['contacts', 'deals']) {
    await t.test(object + ' create failure is recorded without proceeding', async () => {
      const p = await seed(); fault = (m, path) => m === 'POST' && path === '/crm/v3/objects/' + object;
      assert.equal((await sync.synchronize(p.order_id)).status, 'failed');
      const s = await state(p.order_id);
      assert.equal(s.attempts[0].status, 'failed'); assert.equal(s.order.hubspot_deal_id, null);
      if (object === 'deals') assert.ok(s.order.hubspot_contact_id);
    });
  }

  await t.test('webhook accepts persisted order on sync failure; duplicates do not retry it', async () => {
    const p = payload(); fault = (m, path) => path.endsWith('/contacts/search');
    assert.equal((await webhook(p)).status, 201);
    assert.equal((await state(p.order_id)).order.status, 'failed');
    const before = calls.length;
    assert.equal((await webhook(p)).status, 200);
    assert.equal(calls.length, before);
    assert.equal((await state(p.order_id)).attempts.length, 1);
  });

  await t.test('does not recreate a previously saved but missing Deal', async () => {
    const p = await seed();
    await source.query("UPDATE public.orders SET hubspot_deal_id='999999' WHERE order_id=$1", [p.order_id]);
    const before = countCreates('deals');
    assert.equal((await sync.synchronize(p.order_id)).status, 'failed');
    assert.equal(countCreates('deals'), before);
    assert.match((await state(p.order_id)).order.last_error, /previous_deal_missing/);
  });

  await t.test('unknown order does not call HubSpot', async () => {
    const before = calls.length;
    assert.equal((await sync.synchronize('missing-' + randomUUID())).status, 'not_found');
    assert.equal(calls.length, before);
  });
});
