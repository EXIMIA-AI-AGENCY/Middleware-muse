'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { TOKEN, KEY, request, listen, close } = require('./helpers');
const { createApp } = require('../src/create-app');
const { loadConfig } = require('../src/config');
const { createAgency, tryCreateAgency } = require('../src/agency');
const { loadAgencyConfig, deriveAccessKey } = require('../src/agency/config');
const { canonicalPath } = require('../src/agency/router');

const AGENCY_TOKEN = 'pit-agency-0123456789abcdef-0123456789abcdef';
const SUB_TOKEN = 'pit-subaccount-0123456789abcdef-0123456789';
const PIN = '24681357';
const LOC = 'L3bLLVwvhdJ7A9WqkPxM';
const COMPANY = 'CompAny0123456789';

const makeLogger = () => {
  const lines = [];
  const logger = {
    info: (f) => lines.push({ level: 'info', ...f }),
    warn: (f) => lines.push({ level: 'warn', ...f }),
    error: (f) => lines.push({ level: 'error', ...f }),
  };
  return { lines, logger };
};

/**
 * Fake GoHighLevel that behaves like GHL for the three tokens: the Eximia sub-account token
 * reads sub-account data, the agency token reads agency routes and is refused inside
 * sub-accounts, and a second sub-account token stands in for a token created in the wrong place.
 */
async function startFakeGhl() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(record);
      const json = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const auth = req.headers.authorization || '';
      const who = auth === `Bearer ${AGENCY_TOKEN}` ? 'agency' : auth === `Bearer ${TOKEN}` ? 'eximia' : auth === `Bearer ${SUB_TOKEN}` ? 'sub' : null;
      if (!who) return json(401, { statusCode: 401, message: 'Invalid Private Integration token' });
      if (!req.headers.version) return json(401, { statusCode: 401, message: 'version header was not found.' });
      const scope = () => json(401, { statusCode: 401, message: 'The token is not authorized for this scope.' });
      const path = req.url.split('?')[0];
      if (req.method === 'GET' && path === `/locations/${LOC}`) return json(200, { location: { id: LOC, name: 'Eximia', companyId: COMPANY } });
      if (path.startsWith('/contacts')) return who === 'agency' ? scope() : json(200, { contacts: [], meta: { total: 3 } });
      if (who !== 'agency') return scope();
      if (path === `/companies/${COMPANY}`) return json(200, { company: { id: COMPANY, name: 'Eximia Agency', locationCount: 7 } });
      if (path === '/locations/search') return json(200, { locations: [{ id: LOC, name: 'Eximia' }] });
      if (path === '/users/search') return json(200, { users: [], count: 0 });
      if (path === '/snapshots/') return json(200, { snapshots: [] });
      if (path.startsWith('/saas/')) {
        if (req.headers.version !== '2021-04-15' && req.headers.version !== 'v3') return json(401, { status: 401, message: 'version header is invalid', error: 'Error', traceId: 't' });
        return json(200, { plans: [] });
      }
      if (path === '/custom-menus/') return json(200, { customMenus: [] });
      return json(200, { ok: true, method: req.method, path });
    });
  });
  const url = await listen(server);
  return { url, requests, close: () => close(server) };
}

/** The whole app (Eximia GHL + agency) against the fake GHL. */
async function setup(t, { env = {}, withAgency = true } = {}) {
  const ghl = await startFakeGhl();
  const fullEnv = { GHL_TOKEN: TOKEN, PROXY_KEY: KEY, GHL_BASE_URL: ghl.url, ADMIN_PIN: PIN, GHL_AGENCY_TOKEN: AGENCY_TOKEN, ...env };
  const config = loadConfig(fullEnv);
  const { lines, logger } = makeLogger();
  const agency = withAgency ? createAgency({ env: fullEnv, ghlConfig: config, logger }) : null;
  const app = createApp(config, logger, { agency });
  const server = http.createServer(app);
  const url = await listen(server);
  app.locals.selfUrl = url;
  t.after(async () => {
    app.locals.limiter.stop();
    if (agency) agency.limiter.stop();
    await close(server);
    await ghl.close();
  });
  return { url, ghl, logs: lines, agency, app, accessKey: agency && agency.config.accessKey };
}

const upstreamOf = (ghl, path) => ghl.requests.filter((r) => r.url.split('?')[0] === path);

// ---------- config ----------

test('config: disabled and not started without a token; never throws', () => {
  const c = loadAgencyConfig({}, {});
  assert.equal(c.enabled, false);
  assert.equal(c.started, false);
  assert.equal(c.accessKey, null);
  assert.equal(c.allowDelete, false);
});

test('config: derives a stable key that differs from the token and the other secrets', () => {
  const ghl = loadConfig({ GHL_TOKEN: TOKEN, PROXY_KEY: KEY, ADMIN_PIN: PIN });
  const c = loadAgencyConfig({ GHL_AGENCY_TOKEN: AGENCY_TOKEN }, { ghl });
  assert.equal(c.enabled, true);
  assert.equal(c.accessKeySource, 'derived');
  assert.equal(c.accessKey, deriveAccessKey(AGENCY_TOKEN));
  assert.equal(c.accessKey.length, 64);
  for (const other of [AGENCY_TOKEN, TOKEN, KEY, PIN]) assert.notEqual(c.accessKey, other);
  assert.notEqual(c.checkMarker, c.accessKey);
});

test('config: problems disable the API with a reason and never name a value', () => {
  const ghl = loadConfig({ GHL_TOKEN: TOKEN, PROXY_KEY: KEY, ADMIN_PIN: PIN });
  const cases = [
    [{ GHL_AGENCY_TOKEN: TOKEN }, /mismo token que GHL_TOKEN/],
    [{ GHL_AGENCY_TOKEN: 'pit-with space' }, /espacios/],
    [{ GHL_AGENCY_TOKEN: AGENCY_TOKEN, GHL_AGENCY_PROXY_KEY: 'short' }, /al menos 32/],
    [{ GHL_AGENCY_TOKEN: AGENCY_TOKEN, GHL_AGENCY_PROXY_KEY: KEY }, /distinta/],
    [{ GHL_AGENCY_TOKEN: AGENCY_TOKEN, GHL_AGENCY_PUBLIC_HOST: 'https://x.vercel.app/' }, /solo un nombre de dominio/],
    [{ GHL_AGENCY_TOKEN: AGENCY_TOKEN, GHL_COMPANY_ID: 'bad id!' }, /GHL_COMPANY_ID/],
  ];
  for (const [env, reason] of cases) {
    const c = loadAgencyConfig(env, { ghl });
    assert.equal(c.enabled, false, JSON.stringify(env));
    assert.equal(c.started, true);
    assert.match(c.problems.join(' '), reason);
    assert.equal(c.token, null);
    for (const v of Object.values(env)) assert.ok(!c.problems.join(' ').includes(v), 'no value in the message');
  }
});

test('config: a Kraken key passed as "others" cannot be reused as the agency key', () => {
  const other = 'k'.repeat(40);
  const c = loadAgencyConfig({ GHL_AGENCY_TOKEN: AGENCY_TOKEN, GHL_AGENCY_PROXY_KEY: other }, { others: [other] });
  assert.equal(c.enabled, false);
});

test('config: deleting sub-accounts is allowed only with exactly "true"', () => {
  for (const [value, expected] of [['true', true], [' true ', true], ['TRUE', false], ['1', false], ['yes', false], ['', false]]) {
    assert.equal(loadAgencyConfig({ GHL_AGENCY_TOKEN: AGENCY_TOKEN, GHL_AGENCY_ALLOW_DELETE: value }).allowDelete, expected, value);
  }
});

test('tryCreateAgency never throws', () => {
  const { lines, logger } = makeLogger();
  assert.equal(tryCreateAgency({ env: { GHL_AGENCY_TOKEN: AGENCY_TOKEN }, ghlConfig: null, logger }), null);
  assert.ok(lines.some((l) => l.msg === 'ghl_agency_disabled'));
});

// ---------- the API ----------

test('agency key: forwarded with the AGENCY token, browser UA, default Version, no Eximia location', async (t) => {
  const { url, ghl, accessKey } = await setup(t);
  const res = await request(`${url}/agency/locations/search?companyId=${COMPANY}&limit=5`, { headers: { 'X-Proxy-Key': accessKey, 'X-Agency-Check': 'x', 'X-Admin-Check': 'y' } });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text).locations[0].id, LOC);
  const [sent] = upstreamOf(ghl, '/locations/search');
  assert.equal(sent.url, `/locations/search?companyId=${COMPANY}&limit=5`);
  assert.equal(sent.headers.authorization, `Bearer ${AGENCY_TOKEN}`);
  assert.equal(sent.headers.version, '2021-07-28');
  assert.match(sent.headers['user-agent'], /Chrome/);
  for (const h of ['x-proxy-key', 'x-agency-check', 'x-admin-check', 'locationid']) assert.equal(sent.headers[h], undefined, h);
});

test('keys are separate: Eximia key cannot open /agency, agency key cannot open /ghl or /mcp', async (t) => {
  const { url, ghl, accessKey } = await setup(t);
  for (const headers of [{}, { 'X-Proxy-Key': KEY }, { 'X-Proxy-Key': `${accessKey}x` }, { 'X-Proxy-Key': AGENCY_TOKEN }]) {
    const res = await request(`${url}/agency/locations/${LOC}`, { headers });
    assert.equal(res.status, 401);
    assert.deepEqual(JSON.parse(res.text), { error: 'unauthorized' });
  }
  assert.equal((await request(`${url}/ghl/locations/${LOC}`, { headers: { 'X-Proxy-Key': accessKey } })).status, 401);
  assert.equal((await request(`${url}/mcp/`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal(ghl.requests.length, 0, 'nothing reached GoHighLevel');

  // Eximia is untouched: its key still works and still uses the Eximia token.
  const eximia = await request(`${url}/ghl/contacts/?locationId=${LOC}&limit=1`, { headers: { 'X-Proxy-Key': KEY } });
  assert.equal(eximia.status, 200);
  assert.equal(ghl.requests.at(-1).headers.authorization, `Bearer ${TOKEN}`);
});

test('GHL refusals inside sub-accounts are passed through verbatim', async (t) => {
  const { url, accessKey } = await setup(t);
  const res = await request(`${url}/agency/contacts/?locationId=${LOC}&limit=1`, { headers: { 'X-Proxy-Key': accessKey } });
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.text).message, 'The token is not authorized for this scope.');
});

test('SaaS routes get Version 2021-04-15 unless Muse sends one', async (t) => {
  const { url, ghl, accessKey } = await setup(t);
  assert.equal((await request(`${url}/agency/saas/agency-plans/${COMPANY}`, { headers: { 'X-Proxy-Key': accessKey } })).status, 200);
  assert.equal(ghl.requests.at(-1).headers.version, '2021-04-15');
  assert.equal((await request(`${url}/agency/saas-api/public-api/locations?companyId=${COMPANY}`, { headers: { 'X-Proxy-Key': accessKey } })).status, 200);
  assert.equal(ghl.requests.at(-1).headers.version, '2021-04-15');
  assert.equal((await request(`${url}/agency/saas/agency-plans/${COMPANY}`, { headers: { 'X-Proxy-Key': accessKey, Version: 'v3' } })).status, 200);
  assert.equal(ghl.requests.at(-1).headers.version, 'v3');
  await request(`${url}/agency/companies/${COMPANY}`, { headers: { 'X-Proxy-Key': accessKey } });
  assert.equal(ghl.requests.at(-1).headers.version, '2021-07-28');
});

test('writes pass through with their body (create a sub-account, update a user)', async (t) => {
  const { url, ghl, accessKey } = await setup(t);
  const body = JSON.stringify({ name: 'Nueva', companyId: COMPANY });
  const res = await request(`${url}/agency/locations/`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/json' }, body });
  assert.equal(res.status, 200);
  assert.equal(ghl.requests.at(-1).method, 'POST');
  assert.equal(ghl.requests.at(-1).body, body);
  assert.equal((await request(`${url}/agency/users/u1`, { method: 'DELETE', headers: { 'X-Proxy-Key': accessKey } })).status, 200);
  assert.equal(ghl.requests.at(-1).method, 'DELETE');
});

test('deleting a sub-account is blocked, whatever the spelling of the path', async (t) => {
  const { url, ghl, accessKey, agency } = await setup(t);
  const paths = [
    '/agency/locations/abc123',
    '/agency/locations/abc123/',
    '/agency/locations/abc123?deleteTwilioAccount=true',
    '/agency//locations//abc123',
    '/agency/LOCATIONS/abc123',
    '/agency/%6Cocations/abc123',
    '/agency/%256Cocations/abc123',
    '/agency/x/../locations/abc123',
    '/agency/%2e%2e/locations/abc123',
    '/agency/./locations/abc123',
    '/agency/locations%2Fabc123',
    '/agency\\locations\\abc123'.replace('/agency\\', '/agency/'),
  ];
  for (const path of paths) {
    const res = await request(url, { method: 'DELETE', path, headers: { 'X-Proxy-Key': accessKey } });
    assert.equal(res.status, 403, path);
    const body = JSON.parse(res.text);
    assert.equal(body.error, 'blocked_by_proxy');
    assert.match(body.message, /Nothing was sent/);
  }
  assert.equal(ghl.requests.length, 0, 'no delete reached GoHighLevel');
  assert.equal(agency.metrics.snapshot().blocked, paths.length);
  // A malformed encoding is refused, never guessed.
  assert.equal((await request(url, { method: 'DELETE', path: '/agency/locations/%zz', headers: { 'X-Proxy-Key': accessKey } })).status, 400);
  // Deeper routes and other methods on a sub-account are not the sub-account delete.
  assert.equal((await request(`${url}/agency/locations/abc123/customFields/f1`, { method: 'DELETE', headers: { 'X-Proxy-Key': accessKey } })).status, 200);
  assert.equal((await request(`${url}/agency/locations/abc123`, { method: 'PUT', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
});

test('method-override headers never reach GoHighLevel', async (t) => {
  const { url, ghl, accessKey } = await setup(t);
  const res = await request(`${url}/agency/locations/abc123`, {
    method: 'POST',
    headers: { 'X-Proxy-Key': accessKey, 'X-HTTP-Method-Override': 'DELETE', 'X-HTTP-Method': 'DELETE', 'X-Method-Override': 'DELETE', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 200);
  const sent = ghl.requests.at(-1);
  assert.equal(sent.method, 'POST');
  for (const h of ['x-http-method-override', 'x-http-method', 'x-method-override']) assert.equal(sent.headers[h], undefined, h);
});

test('with GHL_AGENCY_ALLOW_DELETE=true the delete is forwarded', async (t) => {
  const { url, ghl, accessKey } = await setup(t, { env: { GHL_AGENCY_ALLOW_DELETE: 'true' } });
  const res = await request(`${url}/agency/locations/abc123?deleteTwilioAccount=false`, { method: 'DELETE', headers: { 'X-Proxy-Key': accessKey } });
  assert.equal(res.status, 200);
  assert.equal(ghl.requests.at(-1).method, 'DELETE');
  assert.equal(ghl.requests.at(-1).url, '/locations/abc123?deleteTwilioAccount=false');
});

test('not configured: /agency answers 503 and Eximia keeps working', async (t) => {
  const { url, ghl } = await setup(t, { env: { GHL_AGENCY_TOKEN: '' } });
  const res = await request(`${url}/agency/locations/${LOC}`, { headers: { 'X-Proxy-Key': KEY } });
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.text).error, 'agency_not_configured');
  assert.equal(ghl.requests.length, 0);
  assert.equal((await request(`${url}/ghl/contacts/?locationId=${LOC}`, { headers: { 'X-Proxy-Key': KEY } })).status, 200);
});

test('without the agency module /agency is just an unknown route behind the Eximia key', async (t) => {
  const { url, ghl } = await setup(t, { withAgency: false });
  assert.equal((await request(`${url}/agency/locations/${LOC}`)).status, 401);
  assert.equal((await request(`${url}/agency/locations/${LOC}`, { headers: { 'X-Proxy-Key': KEY } })).status, 404);
  assert.equal(ghl.requests.length, 0);
});

test('own rate limit and own activity, apart from Eximia', async (t) => {
  const { url, accessKey, agency, app } = await setup(t, { env: { RATE_LIMIT_MAX: '2' } });
  const get = (headers = {}) => request(`${url}/agency/locations/${LOC}`, { headers: { 'X-Proxy-Key': accessKey, ...headers } });
  assert.equal((await get()).status, 200);
  assert.equal((await get()).status, 200);
  const limited = await get();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  // The panel's marked test calls do not use Muse's budget.
  assert.equal((await get({ 'X-Agency-Check': agency.config.checkMarker })).status, 200);
  // The Eximia budget is separate.
  assert.equal((await request(`${url}/ghl/locations/${LOC}`, { headers: { 'X-Proxy-Key': KEY } })).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  const a = agency.metrics.snapshot();
  assert.equal(a.calls, 2);
  assert.equal(a.rateLimited, 1);
  assert.equal(a.checks.count, 1);
  assert.ok(a.recent.every((r) => r.path.startsWith('/agency/')));
  const g = app.locals.metrics.snapshot();
  assert.equal(g.calls, 1);
  assert.ok(g.recent.every((r) => r.path.startsWith('/ghl/')));
});

test('a wrong key with the panel marker is not counted as an intrusion', async (t) => {
  const { url, agency } = await setup(t);
  assert.equal((await request(`${url}/agency/locations/${LOC}`, { headers: { 'X-Agency-Check': agency.config.checkMarker } })).status, 401);
  assert.equal((await request(`${url}/agency/locations/${LOC}`)).status, 401);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(agency.metrics.snapshot().rejectedKey, 1);
});

test('logs never contain the agency token or its key', async (t) => {
  const { url, logs, accessKey } = await setup(t);
  await request(`${url}/agency/locations/search?companyId=${COMPANY}&email=a@b.c`, { headers: { 'X-Proxy-Key': accessKey } });
  await request(url, { method: 'DELETE', path: '/agency/locations/abc', headers: { 'X-Proxy-Key': accessKey } });
  await new Promise((r) => setTimeout(r, 50));
  const text = JSON.stringify(logs);
  for (const secret of [AGENCY_TOKEN, accessKey, 'a@b.c']) assert.ok(!text.includes(secret));
  assert.ok(logs.some((l) => l.msg === 'agency_delete_blocked'));
});

test('canonicalPath resolves encodings, dots, slashes and case', () => {
  assert.equal(canonicalPath('/Locations/ABC/?x=1'), '/locations/abc');
  assert.equal(canonicalPath('/a/../b/./c'), '/b/c');
  assert.equal(canonicalPath('/%252e%252e/x'), '/x');
  assert.equal(canonicalPath('/'), '/');
  assert.equal(canonicalPath('/%E0%A4%A'), null);
  assert.equal(canonicalPath('//locations//abc'), '/locations/abc');
  assert.equal(canonicalPath('/%2525252525256Cocations'), null);
});

// ---------- panel ----------

async function login(url) {
  const res = await request(`${url}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
  return res.headers['set-cookie'][0].split(';')[0];
}
const adminPost = (url, p, cookie) => request(`${url}/admin/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });

test('panel: overview, key and live checks', async (t) => {
  const { url, accessKey, agency, app, ghl } = await setup(t);
  assert.equal((await request(`${url}/admin/api/agency/overview`)).status, 401);
  assert.equal((await adminPost(url, '/agency/key', '')).status, 401);
  const cookie = await login(url);

  const checks = await adminPost(url, '/agency/checks', cookie);
  assert.equal(checks.status, 200);
  const c = JSON.parse(checks.text);
  const byId = Object.fromEntries(c.checks.map((x) => [x.id, x.status]));
  assert.deepEqual(byId, { config: 'ok', token: 'ok', scopes: 'ok', proxy: 'ok', auth: 'ok', separate: 'ok', delete: 'ok' });
  assert.equal(c.overall, 'ok');
  assert.deepEqual(c.company, { name: 'Eximia Agency', locationCount: 7 });
  const perms = Object.fromEntries(c.permissions.map((p) => [p.id, p.state]));
  assert.deepEqual(perms, { company: 'ok', locations: 'ok', users: 'ok', snapshots: 'ok', saas: 'ok', menus: 'ok', 'subaccount-data': 'info' });
  // The panel's probes use the agency token only; no write ever.
  assert.ok(ghl.requests.every((r) => r.method === 'GET'));

  const overview = await request(`${url}/admin/api/agency/overview`, { headers: { Cookie: cookie } });
  const o = JSON.parse(overview.text);
  assert.equal(o.configured, true);
  assert.equal(o.allowDelete, false);
  assert.equal(o.connection.company_id, COMPANY, 'the id read by the checks is shown');
  assert.match(o.museMessage, /X-Proxy-Key/);
  assert.match(o.museMessage, /custom\.gohighlevel-agency/);
  assert.match(o.museMessage, /BLOQUEADO/);
  assert.match(o.museMessage, new RegExp(`companyId=${COMPANY}`));
  for (const secret of [accessKey, AGENCY_TOKEN, TOKEN, KEY, PIN]) {
    assert.ok(!overview.text.includes(secret), 'overview leaks no secret');
    assert.ok(!checks.text.includes(secret), 'checks leak no secret');
  }

  const key = await adminPost(url, '/agency/key', cookie);
  assert.equal(JSON.parse(key.text).accessKey, accessKey);

  // The panel's own test calls are not Muse's activity, here or on the Eximia side.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(agency.metrics.snapshot().calls, 0);
  assert.equal(agency.metrics.snapshot().rejectedKey, 0);
  assert.equal(app.locals.metrics.snapshot().rejectedKey, 0);
});

test('panel: allowing deletes is shown as a warning and told to Muse', async (t) => {
  const { url } = await setup(t, { env: { GHL_AGENCY_ALLOW_DELETE: 'true' } });
  const cookie = await login(url);
  const c = JSON.parse((await adminPost(url, '/agency/checks', cookie)).text);
  assert.equal(c.checks.find((x) => x.id === 'delete').status, 'warn');
  const o = JSON.parse((await request(`${url}/admin/api/agency/overview`, { headers: { Cookie: cookie } })).text);
  assert.match(o.museMessage, /PERMITIDO/);
});

test('panel: a sub-account token put in the agency slot is caught', async (t) => {
  const { url } = await setup(t, { env: { GHL_AGENCY_TOKEN: SUB_TOKEN } });
  const cookie = await login(url);
  const c = JSON.parse((await adminPost(url, '/agency/checks', cookie)).text);
  assert.equal(c.checks.find((x) => x.id === 'kind').status, 'fail');
  assert.equal(c.overall, 'fail');
  assert.match(c.permissions.find((p) => p.id === 'company').detail, /companies\.readonly/);
});

test('panel: a token GHL rejects fails the token check', async (t) => {
  const { url } = await setup(t, { env: { GHL_AGENCY_TOKEN: 'pit-wrong-0123456789' } });
  const cookie = await login(url);
  const c = JSON.parse((await adminPost(url, '/agency/checks', cookie)).text);
  const token = c.checks.find((x) => x.id === 'token');
  assert.equal(token.status, 'fail');
  assert.match(token.detail, /no reconoce el token/);
});

test('panel: without the agency token it shows the setup state', async (t) => {
  const { url } = await setup(t, { env: { GHL_AGENCY_TOKEN: '' } });
  const cookie = await login(url);
  const o = JSON.parse((await request(`${url}/admin/api/agency/overview`, { headers: { Cookie: cookie } })).text);
  assert.equal(o.configured, false);
  assert.equal(o.museMessage, null);
  assert.ok(o.scopes.includes('locations.write'));
  assert.equal((await adminPost(url, '/agency/key', cookie)).status, 409);
  const c = JSON.parse((await adminPost(url, '/agency/checks', cookie)).text);
  assert.equal(c.overall, 'setup');
});

test('panel: without the agency module there are no agency endpoints', async (t) => {
  const { url } = await setup(t, { withAgency: false });
  const cookie = await login(url);
  assert.equal((await request(`${url}/admin/api/agency/overview`, { headers: { Cookie: cookie } })).status, 404);
});

test('the Eximia panel and its checks are unchanged by the agency API', async (t) => {
  const { url } = await setup(t);
  const cookie = await login(url);
  const o = JSON.parse((await request(`${url}/admin/api/overview`, { headers: { Cookie: cookie } })).text);
  assert.equal(o.connection.rest_base_path, '/ghl');
  assert.ok(!JSON.stringify(o).includes(crypto.createHash('sha256').update(AGENCY_TOKEN).digest('hex')));
});
