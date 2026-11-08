'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TOKEN, KEY, request, authed, listen, close } = require('./helpers');
const { createApp } = require('../src/create-app');
const { loadConfig } = require('../src/config');
const { tryCreateAgency } = require('../src/agency');
const { AGENCY_TOOLS, EXIMIA_TOOLS } = require('../src/agency/mcp-tools');

const AGENCY_TOKEN = 'pit-agency-0123456789abcdef-0123456789abcdef';
const LOC = 'L3bLLVwvhdJ7A9WqkPxM';
const OTHER = 'OtherLoc0123456789';
const COMPANY = 'CompAny0123456789';
const LOCATION_TOKEN = 'loc-token-for-other-0123456789';

const silent = () => ({ info() {}, warn() {}, error() {} });

/** Fake GHL: MCP (SSE) for the Eximia token, agency REST, and a location-token exchange. */
async function startFakeGhl({ locationTokenOk = true } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (status, b) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(b));
      };
      const auth = req.headers.authorization || '';
      const path = req.url.split('?')[0];
      if (path === '/mcp/') {
        if (auth !== `Bearer ${TOKEN}`) return json(401, { message: 'bad token' });
        const msg = JSON.parse(body);
        const result =
          msg.method === 'tools/list'
            ? { tools: [{ name: 'contacts_get-contacts', inputSchema: { type: 'object' } }] }
            : msg.method === 'tools/call'
              ? { content: [{ type: 'text', text: '{"contacts":[]}' }], isError: false }
              : {};
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
      }
      if (auth === `Bearer ${TOKEN}` && path.startsWith('/invoices')) {
        if (req.method === 'GET' && path === '/invoices/') return json(200, { invoices: [{ _id: 'inv1' }], total: 1 });
        if (req.method === 'GET' && path === '/invoices/schedule') return json(200, { schedules: [{ _id: 'sched000001' }, { _id: 'sched000002' }], total: 2 });
        if (req.method === 'GET' && path === '/invoices/schedule/sched000001') return json(200, { schedule: { _id: 'sched000001', name: 'Plan mensual' } });
        if (req.method === 'POST' && path === '/invoices/schedule/sched000001/cancel') return json(200, { _id: 'sched000001', status: 'cancelled' });
        return json(404, {});
      }
      if (auth === `Bearer ${LOCATION_TOKEN}`) {
        if (path === '/contacts/') return json(200, { contacts: [{ id: 'c1' }], location: new URL(req.url, 'http://x').searchParams.get('locationId') });
        return json(404, {});
      }
      if (auth !== `Bearer ${AGENCY_TOKEN}`) return json(401, { message: 'Invalid Private Integration token' });
      if (path === `/locations/${LOC}`) return json(200, { location: { id: LOC, name: 'Eximia', companyId: COMPANY } });
      if (path === '/locations/search') {
        const q = new URL(req.url, 'http://x').searchParams;
        if (q.get('companyId') !== COMPANY) return json(400, { message: 'companyId' });
        return json(200, { locations: [{ id: LOC, name: 'Eximia', email: 'a@b.c', extra: 'x' }, { id: OTHER, name: 'Cliente Dos' }] });
      }
      if (path === `/companies/${COMPANY}`) return json(200, { company: { id: COMPANY, name: 'Eximia Agency' } });
      if (path === '/oauth/locationToken') {
        if (!locationTokenOk) return json(401, { message: 'The token is not authorized for this scope.' });
        const form = new URLSearchParams(body);
        if (form.get('companyId') !== COMPANY || form.get('locationId') !== OTHER) return json(400, {});
        return json(201, { access_token: LOCATION_TOKEN, expires_in: 86399, locationId: OTHER });
      }
      if (req.method === 'PUT' && path === `/locations/${OTHER}`) return json(200, { ok: true, got: JSON.parse(body) });
      return json(404, { message: 'not found' });
    });
  });
  const url = await listen(server);
  return { url, requests, close: () => close(server) };
}

async function setup(t, { agency = true, locationTokenOk = true, allowDelete = false } = {}) {
  const ghl = await startFakeGhl({ locationTokenOk });
  const config = loadConfig({ GHL_TOKEN: TOKEN, PROXY_KEY: KEY, GHL_BASE_URL: ghl.url });
  const env = agency ? { GHL_AGENCY_TOKEN: AGENCY_TOKEN, ...(allowDelete ? { GHL_AGENCY_ALLOW_DELETE: 'true' } : {}) } : {};
  const agencyMod = tryCreateAgency({ env, ghlConfig: config, logger: silent() });
  const app = createApp(config, silent(), { agency: agencyMod });
  const server = http.createServer(app);
  const url = await listen(server);
  t.after(async () => {
    app.locals.limiter.stop();
    if (agencyMod) agencyMod.limiter.stop();
    await close(server);
    await ghl.close();
  });
  return { url, ghl };
}

const rpc = async (url, method, params, id = 1) => {
  const r = await request(`${url}/mcp/`, {
    method: 'POST',
    headers: authed({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const line = r.text.split('\n').find((l) => l.startsWith('data:'));
  return { status: r.status, type: r.headers['content-type'], msg: line ? JSON.parse(line.slice(5)) : JSON.parse(r.text) };
};
const callTool = async (url, name, args) => {
  const { msg } = await rpc(url, 'tools/call', { name, arguments: args });
  return { isError: msg.result.isError, data: JSON.parse(msg.result.content[0].text) };
};

test('tools/list = GHL sub-account tools + agency tools; other calls still go to GHL', async (t) => {
  const { url, ghl } = await setup(t);
  const list = await rpc(url, 'tools/list', {});
  assert.equal(list.status, 200);
  assert.match(list.type, /text\/event-stream/);
  const names = list.msg.result.tools.map((x) => x.name);
  assert.equal(names[0], 'contacts_get-contacts');
  for (const tool of AGENCY_TOOLS) assert.ok(names.includes(tool.name));
  // GHL saw the Eximia token, never the agency one.
  assert.equal(ghl.requests.at(-1).headers.authorization, `Bearer ${TOKEN}`);

  const sub = await rpc(url, 'tools/call', { name: 'contacts_get-contacts', arguments: {} }, 2);
  assert.equal(sub.msg.result.content[0].text, '{"contacts":[]}');
  assert.equal(JSON.parse(ghl.requests.at(-1).body).params.name, 'contacts_get-contacts');
});

test('without the agency token /mcp/ lists GHL tools plus the Eximia invoice tools only', async (t) => {
  const { url } = await setup(t, { agency: false });
  const list = await rpc(url, 'tools/list', {});
  assert.deepEqual(list.msg.result.tools.map((x) => x.name), ['contacts_get-contacts', ...EXIMIA_TOOLS.map((x) => x.name)]);
  const r = await rpc(url, 'tools/call', { name: 'agency_list-sub-accounts', arguments: {} }, 2);
  // not ours without the agency token: it goes to GHL like any other tool
  assert.equal(r.msg.result.content[0].text, '{"contacts":[]}');
});

test('Eximia invoice tools use the Eximia token and location; cancel needs confirmedByUser', async (t) => {
  const { url, ghl } = await setup(t, { agency: false });
  const list = await callTool(url, 'eximia_list-invoices', { limit: 5, status: 'sent' });
  assert.equal(list.isError, false);
  let seen = ghl.requests.at(-1);
  const q = new URL(seen.url, 'http://x').searchParams;
  assert.equal(new URL(seen.url, 'http://x').pathname, '/invoices/');
  assert.equal(q.get('altId'), LOC);
  assert.equal(q.get('altType'), 'location');
  assert.equal(q.get('limit'), '5');
  assert.equal(q.get('status'), 'sent');
  assert.equal(seen.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen.headers.version, '2021-07-28');

  const schedules = await callTool(url, 'eximia_list-invoice-schedules', {});
  assert.equal(schedules.data.body.schedules.length, 2);
  const one = await callTool(url, 'eximia_get-invoice-schedule', { scheduleId: 'sched000001' });
  assert.equal(one.data.body.schedule._id, 'sched000001');

  const before = ghl.requests.length;
  const notConfirmed = await callTool(url, 'eximia_cancel-invoice-schedule', { scheduleId: 'sched000001' });
  assert.equal(notConfirmed.isError, true);
  assert.equal(notConfirmed.data.error, 'not_confirmed');
  const bad = await callTool(url, 'eximia_cancel-invoice-schedule', { scheduleId: '../../x', confirmedByUser: true });
  assert.equal(bad.isError, true);
  assert.equal(ghl.requests.length, before);

  const done = await callTool(url, 'eximia_cancel-invoice-schedule', { scheduleId: 'sched000001', confirmedByUser: true });
  assert.equal(done.isError, false);
  seen = ghl.requests.at(-1);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/invoices/schedule/sched000001/cancel');
  assert.deepEqual(JSON.parse(seen.body), { altId: LOC, altType: 'location' });
});

test('agency tools: company, sub-accounts, one sub-account', async (t) => {
  const { url, ghl } = await setup(t);
  const company = await callTool(url, 'agency_get-company', {});
  assert.equal(company.isError, false);
  assert.equal(company.data.body.company.name, 'Eximia Agency');
  const subs = await callTool(url, 'agency_list-sub-accounts', { limit: 10 });
  assert.equal(subs.data.count, 2);
  assert.equal(subs.data.locations[1].name, 'Cliente Dos');
  assert.equal(subs.data.locations[0].extra, undefined);
  const one = await callTool(url, 'agency_get-sub-account', { locationId: LOC });
  assert.equal(one.data.body.location.name, 'Eximia');
  const agencyCalls = ghl.requests.filter((r) => r.url !== '/mcp/');
  assert.ok(agencyCalls.every((r) => r.headers.authorization === `Bearer ${AGENCY_TOKEN}`));
});

test('agency_api-request: writes pass, {companyId} fills, delete is blocked, path tricks refused', async (t) => {
  const { url, ghl } = await setup(t);
  const put = await callTool(url, 'agency_api-request', { method: 'PUT', path: `/locations/${OTHER}`, body: { name: 'Nuevo' } });
  assert.equal(put.isError, false);
  assert.deepEqual(put.data.body.got, { name: 'Nuevo' });
  const search = await callTool(url, 'agency_api-request', { method: 'GET', path: '/locations/search', query: { companyId: '{companyId}' } });
  assert.equal(search.isError, false);
  assert.equal(search.data.body.locations.length, 2);
  const filled = await callTool(url, 'agency_api-request', { method: 'GET', path: '/companies/{companyId}' });
  assert.equal(filled.data.body.company.id, COMPANY);

  const before = ghl.requests.length;
  for (const path of [`/locations/${OTHER}`, `/LOCATIONS/${OTHER}/`, `/locations/x/../${OTHER}`]) {
    const del = await callTool(url, 'agency_api-request', { method: 'DELETE', path });
    assert.equal(del.isError, true, path);
  }
  for (const path of ['//evil.example/x', 'locations', '/a#b', '/oauth/locationToken', '/x/%2e%2e/y']) {
    const r = await callTool(url, 'agency_api-request', { method: 'GET', path });
    assert.equal(r.isError, true, path);
  }
  assert.equal(ghl.requests.length, before);
});

test('agency_sub-account-request uses a location token from the agency token', async (t) => {
  const { url, ghl } = await setup(t);
  const r = await callTool(url, 'agency_sub-account-request', { locationId: OTHER, method: 'GET', path: '/contacts/', query: { locationId: '{locationId}' } });
  assert.equal(r.data.body.location, OTHER);
  const r2 = await callTool(url, 'agency_sub-account-request', { locationId: OTHER, method: 'GET', path: '/contacts/?locationId={locationId}' });
  assert.equal(r2.data.body.location, OTHER);
  const contactCalls = ghl.requests.filter((x) => x.url.startsWith('/contacts/'));
  assert.ok(contactCalls.every((x) => x.headers.authorization === `Bearer ${LOCATION_TOKEN}`));
  // token cached: one exchange
  assert.equal(ghl.requests.filter((x) => x.url === '/oauth/locationToken').length, 1);
});

test('when GHL refuses the location token, the tool says so plainly', async (t) => {
  const { url } = await setup(t, { locationTokenOk: false });
  const r = await callTool(url, 'agency_sub-account-request', { locationId: OTHER, method: 'GET', path: '/contacts/' });
  assert.equal(r.isError, true);
  assert.equal(r.data.body.error, 'location_token_refused');
});

test('agency tools never leak the agency token in results', async (t) => {
  const { url } = await setup(t);
  const { msg } = await rpc(url, 'tools/call', { name: 'agency_list-sub-accounts', arguments: {} });
  assert.ok(!JSON.stringify(msg).includes(AGENCY_TOKEN));
  const sub = await rpc(url, 'tools/call', { name: 'agency_sub-account-request', arguments: { locationId: OTHER, method: 'GET', path: '/contacts/' } });
  assert.ok(!JSON.stringify(sub.msg).includes(LOCATION_TOKEN));
});
