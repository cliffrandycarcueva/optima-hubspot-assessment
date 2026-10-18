const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
process.env.WEBHOOK_SECRET = 'retry-test-webhook-secret';
process.env.HUBSPOT_ACCESS_TOKEN = 'mock-token';
process.env.HUBSPOT_PIPELINE_ID = 'test-pipeline';
process.env.HUBSPOT_DEAL_STAGE_ID = 'test-stage';
process.env.HUBSPOT_ORDER_ID_PROPERTY = 'optima_order_id';
for (const name of ['HUBSPOT_RETRY_MAX_ATTEMPTS', 'HUBSPOT_RETRY_INITIAL_DELAY_MS', 'HUBSPOT_RETRY_MULTIPLIER', 'HUBSPOT_RETRY_MAX_DELAY_MS']) delete process.env[name];
// Two automatic attempts per order; schedules land a day ahead so no running scheduler
// touches test rows. Tests move next_retry_at into the past explicitly when needed.
process.env.SYNC_AUTO_RETRY_MAX_ATTEMPTS = '2';
process.env.SYNC_AUTO_RETRY_INITIAL_DELAY_MS = '86400000';
process.env.SYNC_AUTO_RETRY_MAX_DELAY_MS = '86400000';
const { backoffDelay, parseRetryAfter, httpRetryPolicy, orderRetryPolicy } = require('../dist/hubspot/retry');
const { HubSpotService, HubSpotError } = require('../dist/hubspot/hubspot.service');
const { createApplication } = require('../dist/application');
const { OrderSyncService } = require('../dist/sync/order-sync.service');
const { RetrySchedulerService } = require('../dist/sync/retry-scheduler.service');
const source = require('../dist/database/data-source').default;

const nativeFetch = global.fetch;
function json(body, status = 200, headers = {}) { return new Response(JSON.stringify(body), { status, headers }); }

test('backoff, jitter and Retry-After parsing', async (t) => {
  const policy = { initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 };
  await t.test('exponential caps: 1s, 2s, 4s, 8s, 16s, then 30s maximum', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(n => backoffDelay(n, policy, () => 1)), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
  await t.test('equal jitter stays within [cap/2, cap]', () => {
    assert.equal(backoffDelay(3, policy, () => 0), 2000);
    assert.equal(backoffDelay(3, policy, () => 1), 4000);
    assert.equal(backoffDelay(3, policy, () => 0.5), 3000);
    for (let i = 0; i < 500; i++) {
      const retry = 1 + (i % 8), cap = Math.min(30000, 1000 * 2 ** (retry - 1)), delay = backoffDelay(retry, policy);
      assert.ok(delay >= cap / 2 && delay <= cap, retry + ':' + delay);
    }
    assert.equal(backoffDelay(1, policy, () => 7), 1000);
    assert.equal(backoffDelay(1, policy, () => -3), 500);
  });
  await t.test('Retry-After supports delta-seconds and HTTP-date', () => {
    const now = Date.UTC(2026, 9, 18, 12, 0, 0);
    assert.equal(parseRetryAfter('0', now), 0);
    assert.equal(parseRetryAfter('7', now), 7000);
    assert.equal(parseRetryAfter(new Date(now + 12000).toUTCString(), now), 12000);
    assert.equal(parseRetryAfter(new Date(now - 5000).toUTCString(), now), 0);
    assert.equal(parseRetryAfter('soon', now), null);
    assert.equal(parseRetryAfter(undefined, now), null);
  });
  await t.test('defaults and configuration validation', () => {
    assert.deepEqual(httpRetryPolicy(), { maxAttempts: 5, initialDelayMs: 1000, multiplier: 2, maxDelayMs: 30000 });
    process.env.HUBSPOT_RETRY_MAX_ATTEMPTS = '0';
    assert.throws(() => httpRetryPolicy(), /HUBSPOT_RETRY_MAX_ATTEMPTS/);
    process.env.HUBSPOT_RETRY_MAX_ATTEMPTS = 'abc';
    assert.throws(() => httpRetryPolicy(), /HUBSPOT_RETRY_MAX_ATTEMPTS/);
    delete process.env.HUBSPOT_RETRY_MAX_ATTEMPTS;
    process.env.SYNC_AUTO_RETRY_ENABLED = 'maybe';
    assert.throws(() => orderRetryPolicy(), /SYNC_AUTO_RETRY_ENABLED/);
    delete process.env.SYNC_AUTO_RETRY_ENABLED;
    assert.equal(orderRetryPolicy().enabled, true);
  });
  await t.test('transient classification', () => {
    for (const status of [429, 500, 502, 503, 504]) assert.equal(new HubSpotError('x', status).transient, true);
    for (const status of [400, 401, 403, 404, 409, 501]) assert.equal(new HubSpotError('x', status).transient, false);
    assert.equal(new HubSpotError('network_or_timeout').transient, true);
    assert.equal(new HubSpotError('missing_access_token').transient, false);
  });
});

test('HTTP-level retries with mocked HubSpot responses', async (t) => {
  const hubspot = new HubSpotService();
  let delays, responses, calls;
  hubspot.sleep = async ms => { delays.push(ms); };
  hubspot.random = () => 1; // upper jitter bound: delays equal the exponential cap
  function script(...items) {
    delays = []; calls = 0; responses = items;
    global.fetch = async () => {
      calls++;
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) throw next;
      return next();
    };
  }
  t.after(() => { global.fetch = nativeFetch; });
  const ok = () => json({ ok: true });
  const fail = (status, headers) => () => json({ message: 'SECRET' }, status, headers);

  for (const status of [429, 500, 502, 503, 504]) {
    await t.test('HTTP ' + status + ' followed by success', async () => {
      script(fail(status), ok);
      assert.deepEqual(await hubspot.request('GET', '/x'), { ok: true });
      assert.equal(calls, 2); assert.deepEqual(delays, [1000]);
    });
  }
  await t.test('temporary network timeout followed by success', async () => {
    script(new DOMException('timeout', 'TimeoutError'), new TypeError('fetch failed'), ok);
    assert.deepEqual(await hubspot.request('GET', '/x'), { ok: true });
    assert.equal(calls, 3); assert.deepEqual(delays, [1000, 2000]);
  });
  await t.test('maximum attempts exhausted after 5 tries with exponential delays', async () => {
    script(fail(503));
    await assert.rejects(hubspot.request('GET', '/x'), e => e instanceof HubSpotError && e.status === 503 && /gave up after 5 HTTP tries/.test(e.message));
    assert.equal(calls, 5); assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
  });
  for (const status of [400, 401, 403, 404, 409]) {
    await t.test('no retry for HTTP ' + status, async () => {
      script(fail(status), ok);
      await assert.rejects(hubspot.request('GET', '/x'), e => e.status === status);
      assert.equal(calls, 1); assert.deepEqual(delays, []);
    });
  }
  await t.test('Retry-After seconds overrides computed backoff', async () => {
    script(fail(429, { 'retry-after': '7' }), ok);
    await hubspot.request('GET', '/x');
    assert.deepEqual(delays, [7000]);
  });
  await t.test('Retry-After HTTP-date is honored', async () => {
    script(fail(503, { 'retry-after': new Date(Date.now() + 20000).toUTCString() }), ok);
    await hubspot.request('GET', '/x');
    assert.equal(delays.length, 1); assert.ok(delays[0] > 17000 && delays[0] <= 20000, String(delays[0]));
  });
  await t.test('Retry-After beyond the maximum delay is not waited out in-request', async () => {
    script(fail(429, { 'retry-after': '120' }), ok);
    await assert.rejects(hubspot.request('GET', '/x'), e => e.status === 429 && /Retry-After=120/.test(e.message));
    assert.equal(calls, 1); assert.deepEqual(delays, []);
  });
  await t.test('creates are not blindly repeated: retry:false sends once', async () => {
    script(fail(503), ok);
    await assert.rejects(hubspot.request('POST', '/crm/v3/objects/deals', {}, { retry: false }), e => e.status === 503);
    assert.equal(calls, 1);
  });
  await t.test('missing token is permanent', async () => {
    const token = process.env.HUBSPOT_ACCESS_TOKEN; delete process.env.HUBSPOT_ACCESS_TOKEN; script(ok);
    try { await assert.rejects(hubspot.request('GET', '/x'), /missing_access_token/); assert.equal(calls, 0); }
    finally { process.env.HUBSPOT_ACCESS_TOKEN = token; }
  });
});

test('order-level retries with real PostgreSQL and mocked HubSpot', async (t) => {
  const contacts = new Map(), deals = new Map(), associations = new Set(), calls = [];
  let sequence = 5000, hook = null;
  global.fetch = async (input, options = {}) => {
    if (!String(input).startsWith('https://api.hubapi.com/')) return nativeFetch(input, options);
    const url = new URL(input), method = options.method ?? 'GET', path = url.pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, path });
    // hook may return a Response, throw, or return { after } to run default handling then fail.
    const injected = hook ? await hook(method, path, body) : undefined;
    if (injected instanceof Response) return injected;
    const result = handle(method, path, body);
    if (injected && injected.after) return injected.after(result);
    return result;
  };
  function handle(method, path, body) {
    if (path === '/oauth/v2/private-apps/get/access-token-info') return json({ scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.deals.read', 'crm.objects.deals.write'] });
    if (path === '/crm/v3/properties/deals/optima_order_id') return json({ hasUniqueValue: true, type: 'string' });
    if (path === '/crm/v3/pipelines/deals/test-pipeline') return json({ stages: [{ id: 'test-stage' }] });
    if (path === '/account-info/v3/details') return json({ companyCurrency: 'PHP', additionalCurrencies: [] });
    if (path.endsWith('/contacts/search')) {
      const contact = contacts.get(body.filterGroups[0].filters[0].value);
      return json({ results: contact ? [contact] : [] });
    }
    if (path.startsWith('/crm/v3/objects/contacts/') && method === 'GET') {
      const contact = contacts.get(decodeURIComponent(path.split('/').at(-1)));
      return contact ? json(contact) : json({}, 404);
    }
    if (path === '/crm/v3/objects/contacts' && method === 'POST') {
      if (contacts.has(body.properties.email)) return json({}, 409);
      const record = { id: String(++sequence), properties: body.properties };
      contacts.set(body.properties.email, record); return json(record, 201);
    }
    if (path.startsWith('/crm/v3/objects/contacts/') && method === 'PATCH') return json({});
    if (path.startsWith('/crm/v3/objects/deals/') && method === 'GET') {
      const record = deals.get(decodeURIComponent(path.split('/').at(-1)));
      return record ? json(record) : json({}, 404);
    }
    if (path === '/crm/v3/objects/deals' && method === 'POST') {
      const key = body.properties.optima_order_id;
      if (deals.has(key)) return json({}, 409);
      const record = { id: String(++sequence), properties: body.properties };
      deals.set(key, record); return json(record, 201);
    }
    if (path.includes('/associations/default/contacts/') && method === 'PUT') {
      const bits = path.split('/'); associations.add(bits[5] + ':' + bits.at(-1)); return json({});
    }
    if (path.endsWith('/associations/contacts') && method === 'GET') {
      const id = path.split('/')[5];
      return json({ results: [...associations].filter(a => a.startsWith(id + ':')).map(a => ({ toObjectId: a.split(':')[1] })) });
    }
    throw new Error('Unexpected mock request: ' + method + ' ' + path);
  }

  let app = await createApplication();
  const ids = [];
  t.after(async () => {
    global.fetch = nativeFetch;
    try {
      await source.query('DELETE FROM public.sync_attempts WHERE order_id = ANY($1::text[])', [ids]);
      await source.query('DELETE FROM public.orders WHERE order_id = ANY($1::text[])', [ids]);
    } finally { await app.close(); }
  });
  await app.init();
  let delays = [];
  function wire() {
    const hubspot = app.get(HubSpotService);
    hubspot.sleep = async ms => { delays.push(ms); };
    hubspot.random = () => 1;
    return { sync: app.get(OrderSyncService), scheduler: app.get(RetrySchedulerService) };
  }
  let { sync, scheduler } = wire();
  async function seed(status = 'pending') {
    const order_id = 'retry-test-' + randomUUID(); ids.push(order_id);
    const p = { event: 'order.created', order_id, created_at: '2026-09-20T14:32:00+08:00',
      customer: { email: randomUUID() + '@example.com', first_name: 'Maria', last_name: 'Santos' },
      items: [{ sku: 'A', name: 'Item', qty: 1, price: 900 }], currency: 'PHP', total: 900 };
    await source.query('INSERT INTO public.orders (order_id, payload, status) VALUES ($1, $2::jsonb, $3)', [order_id, JSON.stringify(p), status]);
    return p;
  }
  async function state(id) {
    const [order] = await source.query('SELECT * FROM public.orders WHERE order_id=$1', [id]);
    const attempts = await source.query('SELECT * FROM public.sync_attempts WHERE order_id=$1 ORDER BY id', [id]);
    return { order, attempts };
  }
  const makeDue = id => source.query("UPDATE public.orders SET next_retry_at = now() - interval '1 second' WHERE order_id=$1", [id]);
  const creates = object => calls.filter(c => c.method === 'POST' && c.path === '/crm/v3/objects/' + object).length;
  const reset = () => { hook = null; delays = []; };

  await t.test('503 on a read is retried in-request and the order syncs in one attempt', async () => {
    reset(); const p = await seed(); let failures = 0;
    hook = (m, path) => path.endsWith('/contacts/search') && failures++ < 2 ? json({}, 503) : undefined;
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
    const s = await state(p.order_id);
    assert.equal(s.attempts.length, 1); assert.equal(s.attempts[0].triggered_by, 'command');
    assert.equal(s.order.next_retry_at, null); assert.deepEqual(delays, [1000, 2000]);
  });

  await t.test('Deal create 503 after remote success is reconciled without a second create', async () => {
    reset(); const p = await seed(); const before = creates('deals'); let once = true;
    hook = (m, path) => m === 'POST' && path === '/crm/v3/objects/deals' && once ? (once = false, { after: () => json({}, 503) }) : undefined;
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
    assert.equal(creates('deals') - before, 1);
    assert.equal((await state(p.order_id)).order.hubspot_deal_id, deals.get(p.order_id).id);
  });

  await t.test('Deal create timeout after remote success is reconciled by unique order ID', async () => {
    reset(); const p = await seed(); const before = creates('deals'); let once = true;
    hook = (m, path) => m === 'POST' && path === '/crm/v3/objects/deals' && once ? (once = false, { after: () => { throw new DOMException('timeout', 'TimeoutError'); } }) : undefined;
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
    assert.equal(creates('deals') - before, 1);
    assert.equal([...deals.values()].filter(d => d.properties.optima_order_id === p.order_id).length, 1);
  });

  await t.test('Deal create 502 before remote success is created once on the next try', async () => {
    reset(); const p = await seed(); const before = creates('deals'); let once = true;
    hook = (m, path) => m === 'POST' && path === '/crm/v3/objects/deals' && once ? (once = false, json({}, 502)) : undefined;
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
    assert.equal(creates('deals') - before, 2);
    assert.equal([...deals.values()].filter(d => d.properties.optima_order_id === p.order_id).length, 1);
  });

  await t.test('Contact create 504 after remote success does not duplicate the Contact', async () => {
    reset(); const p = await seed(); const before = creates('contacts'); let once = true;
    hook = (m, path) => m === 'POST' && path === '/crm/v3/objects/contacts' && once ? (once = false, { after: () => json({}, 504) }) : undefined;
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
    assert.equal(creates('contacts') - before, 1);
    assert.equal((await state(p.order_id)).order.hubspot_contact_id, contacts.get(p.customer.email).id);
  });

  await t.test('partial success: Contact kept, transient Deal failure scheduled, automatic retry completes once', async () => {
    reset(); const p = await seed();
    hook = (m, path) => m === 'POST' && path === '/crm/v3/objects/deals' ? json({}, 503, { 'retry-after': '1' }) : undefined;
    const result = await sync.synchronize(p.order_id);
    assert.equal(result.status, 'failed'); assert.ok(result.nextRetryAt > new Date(Date.now() + 3600000));
    let s = await state(p.order_id);
    assert.ok(s.order.hubspot_contact_id); assert.equal(s.order.hubspot_deal_id, null);
    assert.equal(s.order.status, 'failed'); assert.equal(s.order.auto_retry_count, 0);
    assert.match(s.order.last_error, /HTTP 503.*gave up after 5 HTTP tries/);
    assert.equal(creates('deals') > 0, true);
    // Not due yet: the scheduler and an automatic trigger both refuse it.
    assert.ok(!(await scheduler.dueOrderIds(1000)).includes(p.order_id));
    assert.deepEqual(await sync.synchronize(p.order_id, { trigger: 'automatic' }), { status: 'not_eligible', skipped: true });
    hook = null; await makeDue(p.order_id);
    assert.ok((await scheduler.dueOrderIds(1000)).includes(p.order_id));
    const before = creates('contacts');
    assert.equal((await sync.synchronize(p.order_id, { trigger: 'automatic' })).status, 'synced');
    s = await state(p.order_id);
    assert.equal(creates('contacts'), before);
    assert.deepEqual(s.attempts.map(a => [a.status, a.triggered_by]), [['failed', 'command'], ['succeeded', 'automatic']]);
    assert.equal(s.order.next_retry_at, null); assert.equal(s.order.auto_retry_count, 1);
    assert.equal([...deals.values()].filter(d => d.properties.optima_order_id === p.order_id).length, 1);
  });

  await t.test('order-level retries stop after the configured budget and keep all failures', async () => {
    reset(); const p = await seed();
    hook = (m, path) => path.endsWith('/contacts/search') ? json({}, 500) : undefined;
    assert.ok((await sync.synchronize(p.order_id, { trigger: 'webhook' })).nextRetryAt);
    for (let i = 1; i <= 2; i++) { await makeDue(p.order_id); assert.equal((await sync.synchronize(p.order_id, { trigger: 'automatic' })).status, 'failed'); }
    const s = await state(p.order_id);
    assert.equal(s.order.status, 'failed'); assert.equal(s.order.next_retry_at, null); assert.equal(s.order.auto_retry_count, 2);
    assert.match(s.order.last_error, /automatic retries exhausted/);
    assert.deepEqual(s.attempts.map(a => [a.status, a.triggered_by]), [['failed', 'webhook'], ['failed', 'automatic'], ['failed', 'automatic']]);
    await source.query("UPDATE public.orders SET next_retry_at = now() - interval '1 second' WHERE order_id=$1", [p.order_id]);
    assert.ok(!(await scheduler.dueOrderIds(1000)).includes(p.order_id));
    assert.equal((await sync.synchronize(p.order_id, { trigger: 'automatic' })).status, 'not_eligible');
    // A manual retry resets the automatic budget.
    hook = null;
    assert.equal((await sync.synchronize(p.order_id, { trigger: 'manual' })).status, 'synced');
    assert.equal((await state(p.order_id)).order.auto_retry_count, 0);
  });

  for (const status of [400, 401, 403]) {
    await t.test('permanent HTTP ' + status + ' is neither retried in-request nor scheduled', async () => {
      reset(); const p = await seed(); const before = calls.length;
      hook = (m, path) => path === '/account-info/v3/details' ? json({}, status) : undefined;
      const result = await sync.synchronize(p.order_id);
      assert.equal(result.status, 'failed'); assert.equal(result.nextRetryAt, null);
      assert.equal(calls.filter((c, i) => i >= before && c.path === '/account-info/v3/details').length, 1);
      const s = await state(p.order_id);
      assert.equal(s.order.next_retry_at, null); assert.doesNotMatch(s.order.last_error, /exhausted/);
      assert.deepEqual(delays, []);
    });
  }

  await t.test('concurrent manual and automatic retries: one lock, one attempt, one Deal', async () => {
    reset(); const p = await seed();
    hook = (m, path) => path.endsWith('/contacts/search') ? json({}, 500) : undefined;
    await sync.synchronize(p.order_id); await makeDue(p.order_id);
    let release, entered; const held = new Promise(r => { release = r; }), ready = new Promise(r => { entered = r; });
    hook = async (m, path) => { if (path === '/oauth/v2/private-apps/get/access-token-info') { entered(); await held; } };
    const automatic = sync.synchronize(p.order_id, { trigger: 'automatic' });
    await ready;
    try {
      assert.deepEqual(await sync.synchronize(p.order_id, { trigger: 'manual' }), { status: 'processing', skipped: true });
      assert.deepEqual(await sync.synchronize(p.order_id, { trigger: 'automatic' }), { status: 'processing', skipped: true });
    } finally { release(); }
    assert.equal((await automatic).status, 'synced');
    assert.deepEqual(await sync.synchronize(p.order_id, { trigger: 'manual' }), { status: 'not_eligible', skipped: true });
    const s = await state(p.order_id);
    assert.deepEqual(s.attempts.map(a => a.triggered_by), ['command', 'automatic']);
    assert.equal([...deals.values()].filter(d => d.properties.optima_order_id === p.order_id).length, 1);
  });

  await t.test('manual retry of a scheduled order clears the schedule so automatic retry skips it', async () => {
    reset(); const p = await seed();
    hook = (m, path) => path.endsWith('/contacts/search') ? json({}, 429) : undefined;
    await sync.synchronize(p.order_id);
    hook = null;
    assert.equal((await sync.synchronize(p.order_id, { trigger: 'manual' })).status, 'synced');
    await makeDue(p.order_id);
    const before = calls.length;
    assert.deepEqual(await sync.synchronize(p.order_id, { trigger: 'automatic' }), { status: 'not_eligible', skipped: true });
    assert.equal(calls.length, before);
    assert.ok(!(await scheduler.dueOrderIds(1000)).includes(p.order_id));
  });

  await t.test('synced orders are never resynchronized by automatic retry', async () => {
    reset(); const p = await seed();
    assert.equal((await sync.synchronize(p.order_id)).status, 'synced');
    await makeDue(p.order_id);
    const before = calls.length;
    assert.ok(!(await scheduler.dueOrderIds(1000)).includes(p.order_id));
    assert.deepEqual(await sync.synchronize(p.order_id, { trigger: 'automatic' }), { status: 'not_eligible', skipped: true });
    assert.equal(calls.length, before); assert.equal((await state(p.order_id)).attempts.length, 1);
  });

  await t.test('stale pending order left by a crash is recovered; fresh pending is left alone', async () => {
    reset(); const stale = await seed(), fresh = await seed();
    await source.query("UPDATE public.orders SET updated_at = now() - interval '10 minutes' WHERE order_id=$1", [stale.order_id]);
    const due = await scheduler.dueOrderIds(1000);
    assert.ok(due.includes(stale.order_id)); assert.ok(!due.includes(fresh.order_id));
    assert.deepEqual(await sync.synchronize(fresh.order_id, { trigger: 'automatic' }), { status: 'not_eligible', skipped: true });
    assert.equal((await sync.synchronize(stale.order_id, { trigger: 'automatic' })).status, 'synced');
  });

  await t.test('schedule survives an application restart', async () => {
    reset(); const p = await seed();
    hook = (m, path) => path.endsWith('/contacts/search') ? json({}, 503) : undefined;
    await sync.synchronize(p.order_id);
    await app.close();
    hook = null;
    app = await createApplication(); await app.init();
    ({ sync, scheduler } = wire());
    await makeDue(p.order_id);
    const results = await scheduler.runDueRetries();
    const mine = results.find(r => r.orderId === p.order_id);
    assert.ok(mine); assert.equal(mine.result.status, 'synced');
    assert.deepEqual((await state(p.order_id)).attempts.map(a => [a.status, a.triggered_by]), [['failed', 'command'], ['succeeded', 'automatic']]);
  });

  await t.test('scheduler start() respects SYNC_AUTO_RETRY_ENABLED and never overlaps', async () => {
    const disabled = new RetrySchedulerService(null, null);
    disabled.policy = { ...disabled.policy, enabled: false };
    assert.equal(disabled.start(), false);
    const enabled = new RetrySchedulerService(null, null);
    enabled.policy = { ...enabled.policy, enabled: true, pollIntervalMs: 3600000 };
    assert.equal(enabled.start(), true); assert.equal(enabled.start(), false);
    await enabled.onModuleDestroy();
  });
});
