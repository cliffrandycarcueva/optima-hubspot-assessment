const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
process.env.DASHBOARD_API_KEY = 'test-dashboard-key-' + randomUUID();
process.env.WEBHOOK_SECRET = 'test-webhook-' + randomUUID();
// Keep automatic retries of test rows a day away from any running scheduler.
process.env.SYNC_AUTO_RETRY_INITIAL_DELAY_MS = '86400000';
process.env.SYNC_AUTO_RETRY_MAX_DELAY_MS = '86400000';
const { Test } = require('@nestjs/testing');
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/application');
const { HubSpotService, HubSpotError } = require('../dist/hubspot/hubspot.service');
const source = require('../dist/database/data-source').default;

test('dashboard endpoints with PostgreSQL and mocked HubSpot', async (t) => {
  let fail = false, hold = null, entered = null, creates = 0;
  const fake = {
    async checkConfiguration() { if (entered) entered(); if (hold) await hold; if (fail) throw new HubSpotError('rate_limited', 429); },
    async syncContact(_p, checkpoint) { await checkpoint('8001'); return '8001'; },
    async ensureDeal(_p, known) { if (!known) creates++; return known ?? '9001'; },
    async associate() {},
  };
  const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(HubSpotService).useValue(fake).compile();
  const app = module.createNestApplication({ bodyParser: false, logger: false });
  configureApplication(app);
  const ids = [];
  t.after(async () => {
    try {
      await source.query('DELETE FROM sync_attempts WHERE order_id = ANY($1::text[])', [ids]);
      await source.query('DELETE FROM orders WHERE order_id = ANY($1::text[])', [ids]);
    } finally { await app.close(); }
  });
  await app.listen(0, '127.0.0.1'); const origin = await app.getUrl();
  async function call(path, method = 'GET', key = process.env.DASHBOARD_API_KEY) {
    const r = await fetch(origin + path, { method, headers: key ? { Authorization: 'Bearer ' + key } : {} });
    return { status: r.status, body: await r.json() };
  }
  async function seed(status = 'failed', index = 0) {
    const id = 'dashboard-test-' + randomUUID(); ids.push(id);
    const payload = { event: 'order.created', order_id: id, created_at: '2026-09-20T14:32:00+08:00',
      customer: { email: 'assessment@example.com', first_name: 'Maria', last_name: 'Santos' },
      items: [{ sku: 'A', name: 'Item', qty: 1, price: 900 }], total: 900, currency: 'PHP' };
    await source.query('INSERT INTO orders (order_id,payload,status) VALUES ($1,$2::jsonb,$3)', [id, JSON.stringify(payload), status]);
    await source.query("INSERT INTO sync_attempts (order_id,status,error,started_at,finished_at) VALUES ($1,'failed','Earlier error',$2,$2)",
      [id, new Date(Date.UTC(2030, 0, 1, 0, index))]);
    return id;
  }

  await t.test('authenticated real database health check', async () => {
    const r = await call('/health'); assert.equal(r.status, 200); assert.equal(r.body.database, 'connected');
  });
  await t.test('read and retry APIs reject missing or incorrect credentials', async () => {
    for (const key of [null, 'wrong']) {
      assert.equal((await call('/sync-attempts', 'GET', key)).status, 401);
      assert.equal((await call('/orders/missing/retry', 'POST', key)).status, 401);
    }
  });
  const seeded = [];
  for (let index = 0; index < 55; index++) seeded.push(await seed(index === 54 ? 'synced' : 'failed', index));
  await t.test('latest 50, newest first, current statuses and safe payload selection', async () => {
    const r = await call('/sync-attempts'); assert.equal(r.status, 200);
    assert.equal(r.body.attempts.length, 50);
    assert.equal(r.body.attempts[0].orderId, seeded[54]);
    assert.equal(r.body.attempts[49].orderId, seeded[5]);
    assert.equal(r.body.attempts[0].attemptStatus, 'failed');
    assert.equal(r.body.attempts[0].orderStatus, 'synced');
    assert.equal(r.body.attempts[0].retryEligible, false);
    assert.equal(r.body.attempts[1].retryEligible, true);
    await source.query("UPDATE orders SET hubspot_contact_id='8100', hubspot_deal_id='9100' WHERE order_id=$1", [seeded[54]]);
    const own = (await call('/sync-attempts')).body.attempts[0];
    assert.equal(own.contactId, null); assert.equal(own.dealId, null);
    assert.equal(r.body.summary.total, 50);
    assert.ok(!JSON.stringify(r.body).includes('assessment@example.com'));
    assert.ok(!('payload' in r.body.attempts[0]));
    for (const key of ['trigger', 'nextRetryAt', 'autoRetryCount']) assert.ok(key in r.body.attempts[0], key);
  });
  await t.test('limit is bounded and malformed limits rejected', async () => {
    assert.equal((await call('/sync-attempts?limit=999')).body.attempts.length, 50);
    assert.equal((await call('/sync-attempts?limit=3')).body.attempts.length, 3);
    for (const limit of ['0', '-1', 'abc', '2.5']) assert.equal((await call('/sync-attempts?limit=' + limit)).status, 400);
  });
  await t.test('retry is denied for synced, pending, processing, or missing orders', async () => {
    assert.equal((await call('/orders/' + seeded[54] + '/retry', 'POST')).status, 409);
    for (const status of ['pending', 'processing']) {
      const id = await seed(status);
      assert.equal((await call('/orders/' + id + '/retry', 'POST')).status, 409);
    }
    assert.equal((await call('/orders/unknown/retry', 'POST')).status, 404);
    assert.equal(creates, 0);
  });
  await t.test('successful retry reuses existing Deal and adds audit attempt', async () => {
    const id = seeded[0];
    await source.query("UPDATE orders SET hubspot_deal_id='9001' WHERE order_id=$1", [id]);
    const r = await call('/orders/' + id + '/retry', 'POST');
    assert.equal(r.status, 200); assert.equal(r.body.status, 'synced'); assert.equal(creates, 0);
    const attempts = await source.query('SELECT status FROM sync_attempts WHERE order_id=$1 ORDER BY id', [id]);
    assert.deepEqual(attempts.map(a => a.status), ['failed', 'succeeded']);
    assert.equal((await call('/orders/' + id + '/retry', 'POST')).status, 409);
  });
  await t.test('failed retry returns 503 and preserves failure history', async () => {
    fail = true; const id = seeded[1];
    assert.equal((await call('/orders/' + id + '/retry', 'POST')).status, 503); fail = false;
    const attempts = await source.query('SELECT status,error FROM sync_attempts WHERE order_id=$1 ORDER BY id', [id]);
    assert.equal(attempts.length, 2); assert.equal(attempts[1].status, 'failed');
    assert.match(attempts[1].error, /429/);
  });
  await t.test('simultaneous retries acquire one lock and create one attempt', async () => {
    const id = seeded[2]; let release;
    hold = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { entered = resolve; });
    const first = call('/orders/' + id + '/retry', 'POST');
    await ready;
    try { assert.equal((await call('/orders/' + id + '/retry', 'POST')).status, 409); }
    finally { release(); hold = null; entered = null; }
    assert.equal((await first).status, 200);
    assert.equal((await source.query('SELECT id FROM sync_attempts WHERE order_id=$1', [id])).length, 2);
  });
  await t.test('error details redact configured secrets', async () => {
    await source.query('UPDATE sync_attempts SET error=$1 WHERE order_id=$2', ['Bearer token ' + process.env.DASHBOARD_API_KEY, seeded[53]]);
    const row = (await call('/sync-attempts')).body.attempts.find(a => a.orderId === seeded[53]);
    assert.ok(!row.error.includes(process.env.DASHBOARD_API_KEY)); assert.match(row.error, /redacted/);
  });
});
