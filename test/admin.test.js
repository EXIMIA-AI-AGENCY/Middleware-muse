'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TOKEN, KEY, startUpstream, startProxy, request } = require('./helpers');
const { createLockout, createSessions } = require('../src/admin');

const PIN = '24681357';
const LOCATION = 'L3bLLVwvhdJ7A9WqkPxM';

/** Fake GHL covering what the dashboard checks call. */
function fakeGhl(req, res, record) {
  const url = new URL(req.url, 'http://x');
  const json = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { statusCode: 401, message: 'Invalid Private Integration token' });
  if (url.pathname === `/locations/${LOCATION}`) return json(200, { location: { id: LOCATION, name: 'Eximia' } });
  if (url.pathname === '/contacts/') return json(200, { contacts: [{ id: 'c1' }], meta: { total: 15247 } });
  if (url.pathname === '/users/') return json(401, { statusCode: 401, message: 'The token is not authorized for this scope.' });
  if (url.pathname === '/mcp/') {
    const msg = JSON.parse(record.body.toString('utf8'));
    const result = msg.method === 'tools/list' ? { tools: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } : { content: [{ type: 'text', text: '{"success":true}' }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
  }
  return json(200, { ok: true });
}

async function setup(t, { env = {}, adminOptions } = {}) {
  const upstream = await startUpstream(fakeGhl);
  const proxy = await startProxy(upstream.url, { ADMIN_PIN: PIN, ...env }, adminOptions ? { adminOptions } : {});
  t.after(async () => {
    await proxy.close();
    await upstream.close();
  });
  return { upstream, proxy };
}

const post = (proxy, path, body, headers = {}) =>
  request(`${proxy.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });

async function login(proxy, pin = PIN) {
  const res = await post(proxy, '/admin/api/login', { pin });
  const cookie = (res.headers['set-cookie'] || [])[0];
  return { res, cookie: cookie ? cookie.split(';')[0] : null };
}

test('without ADMIN_PIN the dashboard does not exist (key auth as before)', async (t) => {
  const upstream = await startUpstream(fakeGhl);
  const proxy = await startProxy(upstream.url);
  t.after(async () => {
    await proxy.close();
    await upstream.close();
  });
  for (const path of ['/admin', '/admin/api/session', '/']) {
    const res = await request(`${proxy.url}${path}`);
    assert.equal(res.status, 401, path);
    assert.deepEqual(JSON.parse(res.text), { error: 'unauthorized' });
  }
});

test('serves the dashboard with strict security headers; / redirects to it', async (t) => {
  const { proxy } = await setup(t);
  const root = await request(`${proxy.url}/`);
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, '/admin');

  const page = await request(`${proxy.url}/admin`);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.doesNotMatch(page.text, /<script>[^<]/, 'no inline scripts');
  assert.ok(!page.text.includes(KEY) && !page.text.includes(TOKEN) && !page.text.includes(PIN));

  for (const [path, type] of [['/admin/app.js', /javascript/], ['/admin/app.css', /text\/css/]]) {
    const res = await request(`${proxy.url}${path}`);
    assert.equal(res.status, 200, path);
    assert.match(res.headers['content-type'], type);
  }
  const https = await request(`${proxy.url}/admin`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(https.headers['strict-transport-security'], /max-age=/);
});

test('PIN login: wrong PIN 401, right PIN sets a hardened session cookie', async (t) => {
  const { proxy } = await setup(t);
  const bad = await login(proxy, '00000000');
  assert.equal(bad.res.status, 401);
  assert.equal(JSON.parse(bad.res.text).error, 'invalid_pin');
  assert.equal(bad.cookie, null);

  const good = await login(proxy);
  assert.equal(good.res.status, 204);
  const raw = good.res.headers['set-cookie'][0];
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.match(raw, /Path=\/admin/);
  assert.ok(!raw.includes(PIN));

  const session = await request(`${proxy.url}/admin/api/session`, { headers: { Cookie: good.cookie } });
  assert.deepEqual(JSON.parse(session.text), { authenticated: true });

  const httpsLogin = await post(proxy, '/admin/api/login', { pin: PIN }, { 'X-Forwarded-Proto': 'https' });
  assert.match(httpsLogin.headers['set-cookie'][0], /Secure/);

  const out = await post(proxy, '/admin/api/logout', {}, { Cookie: good.cookie });
  assert.equal(out.status, 204);
  assert.match(out.headers['set-cookie'][0], /Max-Age=0/);
});

test('API needs a session; forged, tampered or expired cookies are rejected', async (t) => {
  let clock = Date.now();
  const sessions = createSessions({ ttlMs: 60_000, now: () => clock });
  const { proxy } = await setup(t, { adminOptions: { sessions } });
  for (const [method, path] of [['GET', '/admin/api/overview'], ['POST', '/admin/api/key'], ['POST', '/admin/api/checks'], ['GET', '/admin/api/connection.md']]) {
    const res = await request(`${proxy.url}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(res.status, 401, path);
  }
  const { cookie } = await login(proxy);
  const [name, value] = cookie.split('=');
  for (const forged of [`${name}=x`, `${name}=${value.slice(0, -2)}AA`, `${name}=${String(clock + 999_999)}.${value.split('.').slice(1).join('.')}`]) {
    const res = await request(`${proxy.url}/admin/api/overview`, { headers: { Cookie: forged } });
    assert.equal(res.status, 401, forged);
  }
  assert.equal((await request(`${proxy.url}/admin/api/overview`, { headers: { Cookie: cookie } })).status, 200);
  clock += 61_000;
  assert.equal((await request(`${proxy.url}/admin/api/overview`, { headers: { Cookie: cookie } })).status, 401);
});

test('brute force: progressive global lockout, even for the right PIN', async (t) => {
  let clock = Date.now();
  const lockout = createLockout({ freeAttempts: 3, baseLockMs: 10_000, maxLockMs: 40_000, now: () => clock });
  const { proxy } = await setup(t, { adminOptions: { lockout } });
  assert.equal(JSON.parse((await login(proxy, '1')).res.text).attemptsLeft, 2);
  assert.equal(JSON.parse((await login(proxy, '2')).res.text).attemptsLeft, 1);
  const third = await login(proxy, '3');
  assert.equal(third.res.status, 429);
  assert.equal(JSON.parse(third.res.text).retryAfterSeconds, 10);
  assert.equal(third.res.headers['retry-after'], '10');

  const blocked = await login(proxy, PIN);
  assert.equal(blocked.res.status, 429, 'correct PIN is refused while locked');
  assert.equal(blocked.cookie, null);

  clock += 10_001;
  assert.equal(JSON.parse((await login(proxy, '4')).res.text).retryAfterSeconds, 20, 'lock doubles');
  clock += 20_001;
  assert.equal(JSON.parse((await login(proxy, '5')).res.text).retryAfterSeconds, 40);
  clock += 40_001;
  assert.equal(JSON.parse((await login(proxy, '6')).res.text).retryAfterSeconds, 40, 'capped');
  clock += 40_001;
  const ok = await login(proxy);
  assert.equal(ok.res.status, 204);
  assert.equal(JSON.parse((await login(proxy, '7')).res.text).attemptsLeft, 2, 'success resets the counter');
});

test('CSRF guards: JSON only and same origin', async (t) => {
  const { proxy } = await setup(t);
  const form = await request(`${proxy.url}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `pin=${PIN}` });
  assert.equal(form.status, 415);
  const cross = await post(proxy, '/admin/api/login', { pin: PIN }, { Origin: 'https://evil.example' });
  assert.equal(cross.status, 403);
  const same = await post(proxy, '/admin/api/login', { pin: PIN }, { Origin: proxy.url });
  assert.equal(same.status, 204);
  const badJson = await request(`${proxy.url}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(badJson.status, 400);
});

test('overview and CONNECTION.md: exact handoff fields, no secrets', async (t) => {
  const { proxy } = await setup(t);
  const { cookie } = await login(proxy);
  const headers = { Cookie: cookie, 'X-Forwarded-Host': 'ghl-proxy.eximia.agency', 'X-Forwarded-Proto': 'https' };
  const res = await request(`${proxy.url}/admin/api/overview`, { headers });
  assert.equal(res.status, 200);
  const o = JSON.parse(res.text);
  assert.deepEqual(o.connection, {
    middleware_host: 'ghl-proxy.eximia.agency',
    auth_placement: 'header:X-Proxy-Key',
    rest_base_path: '/ghl',
    mcp_path: '/mcp/',
    health_url: 'https://ghl-proxy.eximia.agency/health',
    ghl_location_id: LOCATION,
    version: '1.0.0',
  });
  assert.equal(o.https, true);
  assert.equal(o.config.ghlTokenHint, `pit-…${TOKEN.slice(-4)}`);
  for (const secret of [TOKEN, KEY, PIN]) assert.ok(!res.text.includes(secret), 'overview leaks a secret');

  const md = await request(`${proxy.url}/admin/api/connection.md`, { headers });
  assert.match(md.headers['content-disposition'], /attachment; filename="CONNECTION.md"/);
  assert.equal(md.text.match(/^[a-z_]+: /gm).length, 7);
  assert.match(md.text, /^middleware_host: ghl-proxy\.eximia\.agency$/m);
  for (const secret of [TOKEN, KEY, PIN]) assert.ok(!md.text.includes(secret));

  // A hostile Host header cannot inject content into the handoff.
  const evil = await request(`${proxy.url}/admin/api/overview`, { headers: { Cookie: cookie, 'X-Forwarded-Host': 'evil.example/`<script>"x' } });
  assert.equal(JSON.parse(evil.text).connection.middleware_host, 'PENDIENTE');
});

test('proxy key is only revealed to a session, via POST', async (t) => {
  const { proxy } = await setup(t);
  assert.equal((await post(proxy, '/admin/api/key', {})).status, 401);
  const { cookie } = await login(proxy);
  assert.equal((await request(`${proxy.url}/admin/api/key`, { headers: { Cookie: cookie } })).status, 404);
  const res = await post(proxy, '/admin/api/key', {}, { Cookie: cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { proxyKey: KEY });
});

test('live checks: token, proxy REST/MCP like Muse, auth, permissions and speed', async (t) => {
  const { proxy, upstream } = await setup(t);
  const { cookie } = await login(proxy);
  const res = await post(proxy, '/admin/api/checks', {}, { Cookie: cookie });
  assert.equal(res.status, 200);
  const r = JSON.parse(res.text);
  const byId = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  assert.equal(byId.https.status, 'warn');
  assert.equal(byId.ghl_token.status, 'ok');
  assert.match(byId.ghl_token.detail, /Eximia/);
  assert.equal(byId.proxy_rest.status, 'ok');
  assert.match(byId.proxy_rest.detail, /15[.,\s]?247 contactos/);
  assert.equal(byId.auth.status, 'ok');
  assert.equal(byId.proxy_mcp.status, 'ok');
  assert.match(byId.proxy_mcp.detail, /3 herramientas/);
  assert.equal(r.overall, 'warn');

  const perms = Object.fromEntries(r.permissions.map((p) => [p.id, p]));
  assert.equal(perms.contacts.ok, true);
  assert.equal(perms.users.ok, false);
  assert.match(perms.users.detail, /not authorized for this scope/);

  assert.equal(r.speed.samples, 5);
  assert.equal(typeof r.speed.differenceMs, 'number');

  // The checks' own calls never forward the internal marker or the proxy key to GHL.
  for (const seen of upstream.requests) {
    assert.equal(seen.headers['x-admin-check'], undefined);
    assert.equal(seen.headers['x-proxy-key'], undefined);
  }
  // The deliberate "no key" probe is not counted as an intrusion attempt.
  const o = JSON.parse((await request(`${proxy.url}/admin/api/overview`, { headers: { Cookie: cookie } })).text);
  assert.equal(o.metrics.unauthorized, 0);
  assert.ok(o.metrics.recent.length > 0);
  assert.ok(o.metrics.recent.every((s) => s.check === true));
  assert.ok(o.metrics.last15m.overheadMs.p50 < 50, `overhead ${o.metrics.last15m.overheadMs.p50} ms`);
});

test('the PIN never reaches the logs', async (t) => {
  const { proxy } = await setup(t);
  await login(proxy, '99999999');
  await login(proxy);
  const all = JSON.stringify(proxy.logs);
  assert.ok(!all.includes(PIN) && !all.includes('99999999'));
  assert.ok(proxy.logs.some((l) => l.msg === 'admin_login_failed'));
  assert.ok(proxy.logs.some((l) => l.msg === 'admin_login'));
});
