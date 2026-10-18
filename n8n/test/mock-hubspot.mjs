// Local stand-in for the HubSpot endpoints the n8n workflow uses. Test-only: never use with real data.
// Enforces HubSpot's uniqueness rules (Contact email, Deal optima_order_id) and supports fault injection.
//   node n8n/test/mock-hubspot.mjs [port]        (default 5680, binds 127.0.0.1)
// Control API: POST /__reset, POST /__faults [{method,path,status,times,afterCommit,retryAfter}],
//              GET /__state, POST /__notify (captures error-workflow alerts), GET /__notifications.
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? process.env.MOCK_HUBSPOT_PORT ?? 5680);
let state;
function reset() {
  state = { contacts: new Map(), deals: new Map(), associations: new Set(), calls: [], faults: [], notifications: [], seq: 9000 };
}
reset();

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const read = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    try { resolve(text ? JSON.parse(text) : undefined); } catch { resolve(undefined); }
  });
});

function takeFault(method, path) {
  const fault = state.faults.find((f) => f.times > 0 && (!f.method || f.method === method) && new RegExp(f.path).test(path));
  if (fault) fault.times -= 1;
  return fault;
}

function handle(method, path, url, body) {
  if (method === 'POST' && path === '/crm/v3/objects/contacts/search') {
    const email = body?.filterGroups?.[0]?.filters?.[0]?.value;
    const c = state.contacts.get(String(email).toLowerCase());
    return [200, { total: c ? 1 : 0, results: c ? [c] : [] }];
  }
  if (method === 'GET' && path.startsWith('/crm/v3/objects/contacts/') && url.searchParams.get('idProperty') === 'email') {
    const c = state.contacts.get(decodeURIComponent(path.split('/').at(-1)).toLowerCase());
    return c ? [200, c] : [404, { status: 'error', message: 'resource not found' }];
  }
  if (method === 'POST' && path === '/crm/v3/objects/contacts') {
    const email = String(body?.properties?.email ?? '').toLowerCase();
    if (state.contacts.has(email)) return [409, { status: 'error', category: 'CONFLICT', message: 'Contact already exists' }];
    const c = { id: String(++state.seq), properties: body.properties };
    state.contacts.set(email, c);
    return [201, c];
  }
  if (method === 'PATCH' && path.startsWith('/crm/v3/objects/contacts/')) {
    const id = path.split('/').at(-1);
    const c = [...state.contacts.values()].find((x) => x.id === id);
    if (!c) return [404, { status: 'error' }];
    c.properties = { ...c.properties, ...body.properties };
    return [200, c];
  }
  if (method === 'POST' && path === '/crm/v3/objects/deals/search') {
    const key = body?.filterGroups?.[0]?.filters?.[0]?.value;
    const d = state.deals.get(key);
    return [200, { total: d ? 1 : 0, results: d ? [d] : [] }];
  }
  if (method === 'GET' && path.startsWith('/crm/v3/objects/deals/') && url.searchParams.get('idProperty') === 'optima_order_id') {
    const d = state.deals.get(decodeURIComponent(path.split('/').at(-1)));
    return d ? [200, d] : [404, { status: 'error', message: 'resource not found' }];
  }
  if (method === 'POST' && path === '/crm/v3/objects/deals') {
    const key = body?.properties?.optima_order_id;
    if (state.deals.has(key)) return [400, { status: 'error', category: 'VALIDATION_ERROR', message: 'unique property value already exists' }];
    const d = { id: String(++state.seq), properties: body.properties };
    state.deals.set(key, d);
    return [201, d];
  }
  let m = path.match(/^\/crm\/v4\/objects\/deals\/(\d+)\/associations\/default\/contacts\/(\d+)$/);
  if (method === 'PUT' && m) {
    state.associations.add(m[1] + ':' + m[2]);
    return [200, { status: 'COMPLETE', results: [{ from: { id: m[1] }, to: { id: m[2] } }] }];
  }
  m = path.match(/^\/crm\/v4\/objects\/deals\/(\d+)\/associations\/contacts$/);
  if (method === 'GET' && m) {
    const results = [...state.associations].filter((a) => a.startsWith(m[1] + ':')).map((a) => ({ toObjectId: Number(a.split(':')[1]), associationTypes: [] }));
    return [200, { results }];
  }
  return [404, { status: 'error', message: 'mock: unknown route ' + method + ' ' + path }];
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname, method = req.method;
  const body = await read(req);
  if (path === '/__reset') { reset(); return send(res, 200, { ok: true }); }
  if (path === '/__faults') { state.faults = (body ?? []).map((f) => ({ times: 1, ...f })); return send(res, 200, { ok: true }); }
  if (path === '/__notify') { state.notifications.push(body); return send(res, 200, { ok: true }); }
  if (path === '/__notifications') return send(res, 200, state.notifications);
  if (path === '/__state') {
    return send(res, 200, {
      contacts: [...state.contacts.values()], deals: [...state.deals.values()], associations: [...state.associations],
      calls: state.calls, authHeaders: [...new Set(state.calls.map((c) => c.auth))],
    });
  }
  state.calls.push({ method, path, auth: req.headers.authorization ? req.headers.authorization.replace(/^(Bearer )(.{4}).*$/, '$1$2…') : null });
  if (!req.headers.authorization?.startsWith('Bearer ')) return send(res, 401, { status: 'error', category: 'INVALID_AUTHENTICATION' });
  const fault = takeFault(method, path);
  if (fault && !fault.afterCommit) {
    return send(res, fault.status, { status: 'error', message: 'injected ' + fault.status }, fault.retryAfter ? { 'Retry-After': String(fault.retryAfter) } : {});
  }
  const [status, payload] = handle(method, path, url, body);
  if (fault?.afterCommit) return send(res, fault.status, { status: 'error', message: 'injected ' + fault.status + ' after commit' });
  return send(res, status, payload);
}).listen(port, '127.0.0.1', () => console.log('Mock HubSpot listening on http://127.0.0.1:' + port));
