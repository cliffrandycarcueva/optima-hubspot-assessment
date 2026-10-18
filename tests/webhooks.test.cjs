const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomBytes, randomUUID } = require('node:crypto');

// Only this test process uses this generated secret; .env is never modified.
process.env.WEBHOOK_SECRET = randomBytes(32).toString('hex');
const secret = process.env.WEBHOOK_SECRET;
const { configureApplication } = require('../dist/application');
const { Test } = require('@nestjs/testing');
const { AppModule } = require('../dist/app.module');
const { OrderSyncService } = require('../dist/sync/order-sync.service');
const dataSource = require('../dist/database/data-source').default;

test('order.created webhook over HTTP with real PostgreSQL', async (t) => {
  // Keep receiver tests focused on authentication, validation, and persistence.
  // sync.test.cjs exercises real orchestration with mocked HubSpot HTTP responses.
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(OrderSyncService).useValue({ synchronize: async () => ({ status: 'pending' }) }).compile();
  const app = module.createNestApplication({ bodyParser: false, logger: false });
  configureApplication(app);
  const ids = [];
  t.after(async () => {
    try {
      if (dataSource.isInitialized && ids.length) {
        await dataSource.query('DELETE FROM public.orders WHERE order_id = ANY($1::text[])', [ids]);
      }
    } finally { await app.close(); }
  });
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl() + '/webhooks/orders';

  function sample() {
    const order_id = 'webhook-test-' + randomUUID();
    ids.push(order_id);
    return {
      event: 'order.created', order_id, created_at: '2026-09-20T14:32:00+08:00',
      customer: { email: 'test@example.com', first_name: 'Maria', last_name: 'Santos', phone: '+639171234567' },
      items: [{ sku: 'TSH-BLK-M', name: 'Black Tee (M)', qty: 2, price: 450 }],
      currency: 'PHP', total: 900,
    };
  }
  function sign(body, key = secret) {
    return 'sha256=' + createHmac('sha256', key).update(body).digest('hex');
  }
  async function send(body, signature = sign(body), contentType = 'application/json') {
    const headers = { 'Content-Type': contentType };
    if (signature !== null) headers['X-Webhook-Signature'] = signature;
    const response = await fetch(url, { method: 'POST', body, headers, signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  }
  async function rows(orderId) {
    return dataSource.query('SELECT * FROM public.orders WHERE order_id = $1', [orderId]);
  }

  await t.test('valid signature persists the original JSON and leaves sync pending', async () => {
    const payload = sample();
    const result = await send(JSON.stringify(payload));
    assert.equal(result.status, 201);
    assert.deepEqual(result.body, { order_id: payload.order_id, result: 'accepted' });
    const [saved] = await rows(payload.order_id);
    assert.deepEqual(saved.payload, payload);
    assert.equal(saved.status, 'pending');
    assert.equal(saved.hubspot_contact_id, null);
    assert.equal(saved.hubspot_deal_id, null);
    assert.ok(saved.created_at instanceof Date);
    const attempts = await dataSource.query('SELECT id FROM public.sync_attempts WHERE order_id = $1', [payload.order_id]);
    assert.equal(attempts.length, 0);
  });

  await t.test('HMAC uses exact bytes, including whitespace and Unicode', async () => {
    const payload = sample();
    payload.customer.first_name = 'María';
    const pretty = JSON.stringify(payload, null, 2);
    assert.equal((await send(pretty, sign(JSON.stringify(payload)))).status, 401);
    assert.equal((await rows(payload.order_id)).length, 0);
    assert.equal((await send(pretty)).status, 201);
    assert.deepEqual((await rows(payload.order_id))[0].payload, payload);
  });

  await t.test('missing, wrong-secret, malformed and duplicate signatures return 401', async () => {
    const payload = sample();
    const body = JSON.stringify(payload);
    for (const signature of [null, '', 'sha256=abc', 'sha256=' + 'g'.repeat(64), '0'.repeat(64),
      sign(body, 'wrong-secret'), sign(body) + ', ' + sign(body)]) {
      assert.equal((await send(body, signature)).status, 401);
    }
    assert.equal((await rows(payload.order_id)).length, 0);
    // Authentication takes precedence over JSON parsing.
    assert.equal((await send('{invalid', null)).status, 401);
  });

  await t.test('tampered payload returns 401 and is not persisted', async () => {
    const payload = sample();
    const signature = sign(JSON.stringify(payload));
    payload.total = 1;
    assert.equal((await send(JSON.stringify(payload), signature)).status, 401);
    assert.equal((await rows(payload.order_id)).length, 0);
  });

  await t.test('signed malformed JSON, invalid UTF-8, scalars and arrays return 400', async () => {
    for (const body of ['', '{broken', 'null', '[]', '"text"', '123', Buffer.from([0xff, 0xfe])]) {
      assert.equal((await send(body)).status, 400);
    }
    const payload = sample();
    assert.equal((await send(JSON.stringify(payload), undefined, 'text/plain')).status, 400);
    assert.equal((await rows(payload.order_id)).length, 0);
  });

  const invalid = [
    ['wrong event', p => { p.event = 'order.updated'; }],
    ['missing order ID', p => { delete p.order_id; }],
    ['blank order ID', p => { p.order_id = ' '; }],
    ['missing customer', p => { delete p.customer; }],
    ['null customer', p => { p.customer = null; }],
    ['array customer', p => { p.customer = []; }],
    ['invalid email', p => { p.customer.email = 'invalid'; }],
    ['missing first name', p => { delete p.customer.first_name; }],
    ['blank last name', p => { p.customer.last_name = '  '; }],
    ['null optional phone', p => { p.customer.phone = null; }],
    ['negative total', p => { p.total = -1; }],
    ['string total', p => { p.total = '900'; }],
    ['missing total', p => { delete p.total; }],
    ['invalid currency', p => { p.currency = 'ZZZ'; }],
    ['invalid date', p => { p.created_at = '2026-02-30T12:00:00Z'; }],
    ['date without timezone', p => { p.created_at = '2026-09-20T12:00:00'; }],
    ['missing items', p => { delete p.items; }],
    ['empty items', p => { p.items = []; }],
    ['fractional quantity', p => { p.items[0].qty = 1.5; }],
    ['negative price', p => { p.items[0].price = -1; }],
    ['unknown field', p => { p.admin = true; }],
    ['unknown nested field', p => { p.customer.admin = true; }],
    ['NUL character', p => { p.customer.first_name = '\u0000'; }],
    ['unpaired Unicode surrogate', p => { p.customer.first_name = '\ud800'; }],
  ];
  for (const [label, mutate] of invalid) {
    await t.test('validation rejects ' + label, async () => {
      const payload = sample();
      const originalId = payload.order_id;
      mutate(payload);
      const response = await send(JSON.stringify(payload));
      assert.equal(response.status, 400);
      assert.equal((await rows(originalId)).length, 0);
      assert.ok(!JSON.stringify(response.body).includes(secret));
    });
  }

  await t.test('duplicate returns 200 and does not overwrite the first payload', async () => {
    const payload = sample();
    assert.equal((await send(JSON.stringify(payload))).status, 201);
    const [before] = await rows(payload.order_id);
    payload.total = 800;
    const duplicate = await send(JSON.stringify(payload));
    assert.equal(duplicate.status, 200);
    assert.deepEqual(duplicate.body, { order_id: payload.order_id, result: 'duplicate' });
    const saved = await rows(payload.order_id);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].payload.total, 900);
    assert.deepEqual(saved[0].updated_at, before.updated_at);
    // Duplicates still require a valid payload.
    payload.total = -1;
    assert.equal((await send(JSON.stringify(payload))).status, 400);
  });

  await t.test('12 concurrent deliveries produce exactly one row and one 201', async () => {
    const payload = sample();
    const body = JSON.stringify(payload);
    const responses = await Promise.all(Array.from({ length: 12 }, () => send(body)));
    assert.equal(responses.filter(r => r.status === 201).length, 1);
    assert.equal(responses.filter(r => r.status === 200 && r.body.result === 'duplicate').length, 11);
    assert.equal((await rows(payload.order_id)).length, 1);
  });

  await t.test('optional phone can be omitted and a zero total is valid', async () => {
    const payload = sample();
    delete payload.customer.phone;
    payload.total = 0;
    payload.items[0].price = 0;
    assert.equal((await send(JSON.stringify(payload))).status, 201);
  });
});
