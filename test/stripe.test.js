'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TOKEN, KEY, request, listen, close } = require('./helpers');
const { createApp } = require('../src/create-app');
const { loadConfig } = require('../src/config');
const { createStripe, tryCreateStripe } = require('../src/stripe');
const { loadStripeConfig, deriveAccessKey } = require('../src/stripe/config');
const { stripePath, toForm, blockedBy } = require('../src/stripe/guard');
const { retryableResponse, backoffMs, DEFAULT_API_VERSION } = require('../src/stripe/client');

const SECRET = 'rk_test_51AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const PIN = '24681357';

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
 * Fake api.stripe.com: checks the key, records every request, keeps idempotent results like
 * Stripe (same key -> same answer, Idempotent-Replayed: true), and lets a test script the
 * first answers of a route: fake.script('POST /v1/customers', ['drop', {status: 500, ...}]).
 */
async function startFakeStripe({ secret = SECRET, denied = [] } = {}) {
  const requests = [];
  const scripts = new Map();
  const idempotent = new Map();
  let seq = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = req.url.split('?')[0];
      const record = { method: req.method, url: req.url, path, headers: req.headers, body };
      requests.push(record);
      const send = (status, payload, headers = {}) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Request-Id': `req_${requests.length}`, 'Content-Length': Buffer.byteLength(text), ...headers });
        res.end(text);
      };
      if (req.headers.authorization !== `Bearer ${secret}`) return send(401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided: rk_test_****' } });
      const queue = scripts.get(`${req.method} ${path}`);
      if (queue && queue.length) {
        const step = queue.shift();
        if (step === 'drop') return req.socket.destroy();
        return send(step.status, step.body || { error: { type: 'api_error', message: 'scripted' } }, step.headers);
      }
      if (denied.includes(path)) {
        return send(403, { error: { type: 'invalid_request_error', message: `The provided key 'rk_test_***' does not have the required permissions for this endpoint. Having the 'rak_x_read' permission would allow this request to continue.` } });
      }
      const key = req.headers['idempotency-key'];
      if (req.method === 'POST' && key && idempotent.has(key)) {
        const first = idempotent.get(key);
        return send(first.status, first.payload, { 'Idempotent-Replayed': 'true' });
      }
      let status = 200;
      let payload;
      if (path === '/v1/balance') payload = { object: 'balance', available: [{ amount: 1234, currency: 'usd' }], pending: [], livemode: false };
      else if (path === '/v1/account') payload = { object: 'account', id: 'acct_123', country: 'US', default_currency: 'usd', charges_enabled: true, payouts_enabled: true, business_profile: { name: 'Eximia Test' }, email: 'secret-owner@example.com' };
      else if (req.method === 'GET') payload = { object: 'list', data: [], has_more: false, url: path };
      else if (req.method === 'POST' && path === '/v1/charges') {
        status = 402;
        payload = { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } };
      } else {
        seq += 1;
        const params = /json/.test(req.headers['content-type'] || '') ? JSON.parse(body || '{}') : Object.fromEntries(new URLSearchParams(body));
        payload = { id: `obj_${seq}`, object: 'thing', method: req.method, path, params };
      }
      if (req.method === 'POST' && key) idempotent.set(key, { status, payload });
      return send(status, payload);
    });
  });
  const url = await listen(server);
  return {
    url,
    requests,
    script: (route, steps) => scripts.set(route, [...steps]),
    close: () => close(server),
  };
}

async function setup(t, { env = {}, withStripe = true, denied } = {}) {
  const stripe = await startFakeStripe({ denied });
  const ghl = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ location: { id: 'L3bLLVwvhdJ7A9WqkPxM' } }));
  });
  const ghlUrl = await listen(ghl);
  const fullEnv = { GHL_TOKEN: TOKEN, PROXY_KEY: KEY, GHL_BASE_URL: ghlUrl, ADMIN_PIN: PIN, STRIPE_SECRET_KEY: SECRET, STRIPE_BASE_URL: stripe.url, ...env };
  const config = loadConfig(fullEnv);
  const { lines, logger } = makeLogger();
  const mod = withStripe ? createStripe({ env: fullEnv, ghlConfig: config, logger, clientOptions: { sleep: () => Promise.resolve() } }) : null;
  const app = createApp(config, logger, { stripe: mod });
  const server = http.createServer(app);
  const url = await listen(server);
  app.locals.selfUrl = url;
  t.after(async () => {
    app.locals.limiter.stop();
    if (mod) mod.limiter.stop();
    await close(server);
    await close(ghl);
    await stripe.close();
  });
  return { url, stripe, logs: lines, mod, app, accessKey: mod && mod.config.accessKey };
}

const json = (res) => JSON.parse(res.text);
let keySeq = 0;
const ikey = () => ({ 'Idempotency-Key': `test-key-${(keySeq += 1)}` });
const form = (s) => Object.fromEntries(new URLSearchParams(s));

// ---------- config ----------

test('config: accepts secret and restricted keys, live and test', () => {
  for (const [key, mode, kind] of [
    ['sk_live_abcdefghij0123456789', 'live', 'secret'],
    ['rk_live_abcdefghij0123456789', 'live', 'restricted'],
    ['sk_test_abcdefghij0123456789', 'test', 'secret'],
    [SECRET, 'test', 'restricted'],
  ]) {
    const c = loadStripeConfig({ STRIPE_SECRET_KEY: key });
    assert.equal(c.enabled, true, key);
    assert.equal(c.mode, mode);
    assert.equal(c.keyKind, kind);
    assert.equal(c.accessKey, deriveAccessKey(key));
    assert.notEqual(c.accessKey, key);
  }
  const off = loadStripeConfig({});
  assert.equal(off.enabled, false);
  assert.equal(off.started, false);
  assert.equal(off.allowMoneyOut, false);
  assert.equal(off.allowAccessGrants, false);
});

test('config: names the wrong kind of key and never echoes it', () => {
  const cases = [
    ['pk_live_abcdefghij0123456789', /PUBLICABLE/],
    ['whsec_abcdefghij0123456789', /webhook/],
    ['pit-00000000-0000-4000-8000-000000000000', /GoHighLevel/],
    ['sk_live_abc def', /espacios/],
    ['hello_world', /no parece una clave de Stripe/],
  ];
  for (const [key, reason] of cases) {
    const c = loadStripeConfig({ STRIPE_SECRET_KEY: key });
    assert.equal(c.enabled, false, key);
    assert.match(c.problems.join(' '), reason);
    assert.ok(!c.problems.join(' ').includes(key));
  }
  assert.match(loadStripeConfig({ STRIPE_SECRET_KEY: SECRET, STRIPE_BASE_URL: 'https://x.com/path' }).problems.join(' '), /solo un origen/);
  assert.match(loadStripeConfig({ STRIPE_SECRET_KEY: SECRET, STRIPE_API_VERSION: 'latest' }).problems.join(' '), /STRIPE_API_VERSION/);
  assert.match(loadStripeConfig({ STRIPE_SECRET_KEY: SECRET, STRIPE_PROXY_KEY: KEY }, { ghl: { proxyKey: KEY } }).problems.join(' '), /distinta/);
});

test('config: switches only turn on with exactly "true"', () => {
  for (const [value, expected] of [['true', true], ['TRUE', false], ['1', false], ['', false]]) {
    const c = loadStripeConfig({ STRIPE_SECRET_KEY: SECRET, STRIPE_ALLOW_MONEY_OUT: value, STRIPE_ALLOW_ACCESS_GRANTS: value });
    assert.equal(c.allowMoneyOut, expected, value);
    assert.equal(c.allowAccessGrants, expected, value);
  }
});

test('tryCreateStripe never throws', () => {
  const { logger } = makeLogger();
  assert.equal(tryCreateStripe({ env: { STRIPE_SECRET_KEY: SECRET }, ghlConfig: null, logger }), null);
});

// ---------- guard helpers ----------

test('stripePath: decodes once, refuses anything ambiguous', () => {
  assert.equal(stripePath('/v1/Customers/cus_1?limit=1'), '/v1/customers/cus_1');
  assert.equal(stripePath('/v1/pay%6Futs'), '/v1/payouts');
  assert.equal(stripePath('/v1/payouts/'), '/v1/payouts');
  assert.equal(stripePath('/v1/coupons/50%25OFF'), '/v1/coupons/50%off');
  for (const bad of ['/v1//payouts', '/v1/payouts%2Fx', '/v1/./payouts', '/v1/../v1/payouts', '/v1/payouts;x', '/v1/pay\\outs', '/v1/payouts#x', '/v1/%zz', '/v3/x', '/', '/health', '/v1/a%00b']) {
    assert.equal(stripePath(bad), null, bad);
  }
});

test('toForm: encodes JSON the way Stripe libraries do', () => {
  const out = form(toForm({ amount: 1050, currency: 'usd', metadata: { order: 'A-1' }, items: [{ price: 'p_1', quantity: 2 }], expand: ['customer'], description: null, flag: true }));
  assert.deepEqual(out, { amount: '1050', currency: 'usd', 'metadata[order]': 'A-1', 'items[0][price]': 'p_1', 'items[0][quantity]': '2', 'expand[0]': 'customer', description: '', flag: 'true' });
});

test('retry rules follow Stripe', () => {
  assert.equal(retryableResponse(500, {}), true);
  assert.equal(retryableResponse(500, { 'stripe-should-retry': 'false' }), false);
  assert.equal(retryableResponse(400, { 'stripe-should-retry': 'true' }), true);
  assert.equal(retryableResponse(409, {}), true);
  assert.equal(retryableResponse(429, {}), true, 'lock timeout');
  assert.equal(retryableResponse(429, { 'stripe-rate-limited-reason': 'global-rate' }), false, 'real rate limit');
  assert.equal(retryableResponse(402, {}), false);
  assert.ok(backoffMs(1, () => 0) >= 500 && backoffMs(5, () => 1) <= 5000);
});

// ---------- the API ----------

test('passthrough: key injected, query and version kept, only Stripe headers forwarded', async (t) => {
  const { url, stripe, accessKey } = await setup(t);
  const res = await request(`${url}/stripe/v1/customers?limit=3&email=a%40b.c`, {
    headers: { 'X-Proxy-Key': accessKey, 'Stripe-Account': 'acct_9', Cookie: 'a=b', 'X-Forwarded-For': '1.2.3.4', Authorization: 'Bearer nope' },
  });
  assert.equal(res.status, 200);
  assert.equal(json(res).object, 'list');
  assert.match(res.headers['request-id'], /^req_/);
  assert.equal(res.headers['cache-control'], 'no-store');
  const [sent] = stripe.requests;
  assert.equal(sent.url, '/v1/customers?limit=3&email=a%40b.c');
  assert.equal(sent.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(sent.headers['stripe-version'], DEFAULT_API_VERSION);
  assert.equal(sent.headers['stripe-account'], 'acct_9');
  for (const h of ['x-proxy-key', 'cookie', 'x-forwarded-for', 'x-stripe-check', 'idempotency-key']) assert.equal(sent.headers[h], undefined, h);
  await request(`${url}/stripe/v1/customers`, { headers: { 'X-Proxy-Key': accessKey, 'Stripe-Version': '2025-03-31.basil' } });
  assert.equal(stripe.requests.at(-1).headers['stripe-version'], '2025-03-31.basil');
});

test('keys are separate and nothing reaches Stripe without the Stripe key', async (t) => {
  const { url, stripe, accessKey } = await setup(t);
  for (const headers of [{}, { 'X-Proxy-Key': KEY }, { 'X-Proxy-Key': `${accessKey}x` }, { 'X-Proxy-Key': SECRET }]) {
    const res = await request(`${url}/stripe/v1/balance`, { headers });
    assert.equal(res.status, 401);
    assert.equal(json(res).error.type, 'proxy_error');
  }
  assert.equal((await request(`${url}/ghl/contacts/`, { headers: { 'X-Proxy-Key': accessKey } })).status, 401);
  assert.equal(stripe.requests.length, 0);
});

test('writes need Muse\'s own Idempotency-Key; it is sent, echoed and replays safely', async (t) => {
  const { url, stripe, accessKey } = await setup(t);
  const body = 'email=ana%40ejemplo.com&metadata[source]=muse';
  const missing = await request(`${url}/stripe/v1/customers`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  assert.equal(missing.status, 400);
  assert.equal(json(missing).error.code, 'idempotency_key_required');
  assert.equal(json(missing).proxy.executed, 'no');
  const delV2 = await request(`${url}/stripe/v2/core/event_destinations/ed_1`, { method: 'DELETE', headers: { 'X-Proxy-Key': accessKey } });
  assert.equal(delV2.status, 403, 'blocked before the key check');
  assert.equal(stripe.requests.length, 0);

  const key = 'b1946ac9-2d2f-4b8a-9e3a-111111111111';
  const res = await request(`${url}/stripe/v1/customers`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': key }, body });
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-proxy-idempotency-key'], key);
  assert.equal(stripe.requests[0].headers['idempotency-key'], key);
  assert.equal(stripe.requests[0].body, body);

  // Repeating with the same key never acts twice.
  const again = await request(`${url}/stripe/v1/customers`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': key }, body });
  assert.equal(again.headers['idempotent-replayed'], 'true');
  assert.equal(json(again).id, json(res).id);

  // Reads and v1 deletes never carry one, and none is echoed; GET bodies are dropped.
  const read = await request(`${url}/stripe/v1/customers`, { headers: { 'X-Proxy-Key': accessKey, 'Idempotency-Key': 'x', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'a=b' });
  assert.equal(read.headers['x-proxy-idempotency-key'], undefined);
  assert.equal(stripe.requests.at(-1).headers['idempotency-key'], undefined);
  assert.equal(stripe.requests.at(-1).body, '');
  const del = await request(`${url}/stripe/v1/customers/cus_1`, { method: 'DELETE', headers: { 'X-Proxy-Key': accessKey, 'Idempotency-Key': 'x' } });
  assert.equal(del.status, 200);
  assert.equal(del.headers['x-proxy-idempotency-key'], undefined);
  assert.equal(stripe.requests.at(-1).headers['idempotency-key'], undefined);
});

test('JSON bodies on v1 become form encoding; v2 stays JSON with a version', async (t) => {
  const { url, stripe, accessKey } = await setup(t);
  const res = await request(`${url}/stripe/v1/payment_links`, {
    method: 'POST',
    headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/json', ...ikey() },
    body: JSON.stringify({ line_items: [{ price: 'price_1', quantity: 1 }], metadata: { a: 'b' } }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-proxy-converted'], 'json-to-form');
  const sent = stripe.requests.at(-1);
  assert.equal(sent.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(form(sent.body), { 'line_items[0][price]': 'price_1', 'line_items[0][quantity]': '1', 'metadata[a]': 'b' });

  await request(`${url}/stripe/v2/core/accounts`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/json', ...ikey() }, body: '{"display_name":"x"}' });
  const v2 = stripe.requests.at(-1);
  assert.equal(v2.body, '{"display_name":"x"}');
  assert.equal(v2.headers['stripe-version'], DEFAULT_API_VERSION);
  assert.ok(v2.headers['idempotency-key']);

  const bad = await request(`${url}/stripe/v1/customers`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/json', ...ikey() }, body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal(json(bad).error.code, 'bad_json');
});

test('a dropped connection is retried with the SAME idempotency key', async (t) => {
  const { url, stripe, accessKey } = await setup(t);
  stripe.script('POST /v1/customers', ['drop']);
  const res = await request(`${url}/stripe/v1/customers`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/x-www-form-urlencoded', ...ikey() }, body: 'name=A' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-proxy-attempts'], '2');
  const posts = stripe.requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].headers['idempotency-key'], posts[1].headers['idempotency-key']);
});

test('lock timeouts and 409 are retried; real rate limits and Should-Retry:false are not', async (t) => {
  const { url, stripe, accessKey } = await setup(t);
  stripe.script('GET /v1/invoices', [{ status: 429, body: { error: { type: 'invalid_request_error', code: 'lock_timeout', message: 'lock' } } }, { status: 409, body: { error: { type: 'idempotency_error', message: 'in use' } } }]);
  const ok = await request(`${url}/stripe/v1/invoices`, { headers: { 'X-Proxy-Key': accessKey } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['x-proxy-attempts'], '3');

  stripe.script('GET /v1/prices', [{ status: 429, headers: { 'Stripe-Rate-Limited-Reason': 'global-rate' }, body: { error: { type: 'invalid_request_error', code: 'rate_limit', message: 'Too many requests' } } }]);
  const limited = await request(`${url}/stripe/v1/prices`, { headers: { 'X-Proxy-Key': accessKey } });
  assert.equal(limited.status, 429);
  assert.equal(json(limited).proxy.safe_to_retry, 'after-wait');
  assert.equal(stripe.requests.filter((r) => r.path === '/v1/prices').length, 1);

  stripe.script('POST /v1/refunds', [{ status: 500, headers: { 'Stripe-Should-Retry': 'false' } }]);
  const failed = await request(`${url}/stripe/v1/refunds`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/x-www-form-urlencoded', ...ikey() }, body: 'charge=ch_1' });
  assert.equal(failed.status, 500);
  const p = json(failed).proxy;
  assert.equal(p.executed, 'unknown');
  assert.equal(p.safe_to_retry, 'same-key');
  assert.equal(p.idempotency_key, failed.headers['x-proxy-idempotency-key']);
  assert.equal(stripe.requests.filter((r) => r.path === '/v1/refunds').length, 1);
});

test('no answer at all: Muse is told exactly how to find out, with the key to repeat', async (t) => {
  const { url, stripe, accessKey } = await setup(t);
  stripe.script('POST /v1/invoices/in_1/pay', ['drop', 'drop', 'drop']);
  const res = await request(`${url}/stripe/v1/invoices/in_1/pay`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, ...ikey() } });
  assert.equal(res.status, 502);
  const body = json(res);
  assert.equal(body.error.type, 'proxy_error');
  assert.equal(body.proxy.executed, 'unknown');
  assert.equal(body.proxy.attempts, 3);
  assert.match(body.proxy.next, new RegExp(res.headers['x-proxy-idempotency-key']));
});

test('Stripe unreachable before sending: the write certainly did not happen', async (t) => {
  const dead = http.createServer();
  const deadUrl = await listen(dead);
  await close(dead);
  const { url, accessKey } = await setup(t, { env: { STRIPE_BASE_URL: deadUrl } });
  const res = await request(`${url}/stripe/v1/customers`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, ...ikey() } });
  assert.equal(res.status, 502);
  assert.equal(json(res).proxy.executed, 'no');
});

test('Stripe errors come back as sent, plus a Spanish explanation', async (t) => {
  const { url, accessKey } = await setup(t, { denied: ['/v1/subscriptions'] });
  const declined = await request(`${url}/stripe/v1/charges`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/x-www-form-urlencoded', ...ikey() }, body: 'amount=100&currency=usd' });
  assert.equal(declined.status, 402);
  const d = json(declined);
  assert.equal(d.error.decline_code, 'insufficient_funds');
  assert.equal(d.proxy.executed, 'no');
  assert.match(d.proxy.summary, /rechazado \(insufficient_funds\).*No se cobró nada/);

  const denied = await request(`${url}/stripe/v1/subscriptions`, { headers: { 'X-Proxy-Key': accessKey } });
  assert.equal(denied.status, 403);
  assert.match(json(denied).proxy.summary, /falta un permiso/);
  assert.equal(json(denied).proxy.executed, undefined, 'reads have no executed field');
});

test('money out and access grants are blocked, whatever the spelling; normal work is not', async (t) => {
  const { url, stripe, accessKey, mod } = await setup(t);
  const call = (method, path, body, type = 'application/x-www-form-urlencoded') =>
    request(url, { method, path: `/stripe${path}`, headers: { 'X-Proxy-Key': accessKey, 'Content-Type': type, ...ikey() }, body });
  const blocked = [
    ['POST', '/v1/payouts', 'amount=100&currency=usd'],
    ['POST', '/v1/PAYOUTS/'],
    ['POST', '/v1/pay%6Futs'],
    ['POST', '/v1/transfers'],
    ['POST', '/v1/payouts/po_1/reverse'],
    ['POST', '/v1/accounts/acct_1/external_accounts'],
    ['DELETE', '/v1/accounts/acct_1/bank_accounts/ba_1'],
    ['POST', '/v1/external_accounts/ba_1'],
    ['POST', '/v1/balance_settings'],
    ['POST', '/v1/account'],
    ['DELETE', '/v1/accounts/acct_1'],
    ['POST', '/v1/accounts/acct_1', 'external_account=btok_1'],
    ['POST', '/v1/accounts/acct_1?settings[payouts][schedule][interval]=daily', 'metadata[a]=b'],
    ['POST', '/v1/accounts', '{"bank_account":{"country":"US"}}', 'application/json'],
    ['POST', '/v2/core/accounts/acct_1', '{"defaults":{"payout_methods":{"usd":"pm_1"}}}', 'application/json'],
    ['POST', '/v2/money_management/outbound_payments', '{}', 'application/json'],
    ['POST', '/v1/issuing/cards'],
    ['POST', '/v1/webhook_endpoints', 'url=https://evil.example'],
    ['DELETE', '/v1/webhook_endpoints/we_1'],
    ['POST', '/v1/file_links', 'file=file_1'],
    ['GET', '/v1/apps/secrets/find?name=x'],
    ['POST', '/v1/account_links'],
    ['POST', '/v1/accounts/acct_1/login_links'],
    ['POST', '/v1/treasury/financial_accounts/fa_1', 'features[outbound_payments][ach][requested]=true'],
    ['POST', '/v1/treasury/credit_reversals', 'received_credit=rc_1'],
    ['POST', '/v1/issuing/cardholders/ich_1', 'status=active'],
    ['POST', '/v1/issuing/tokens/intok_1', 'status=active'],
    ['POST', '/v1/accounts/acct_1', 'payout_schedule[interval]=daily'],
    ['POST', '/v2/core/accounts/acct_1', 'configuration[recipient][default_outbound_destination]=x'],
    ['GET', '/v1/issuing/cards/ic_1?expand[]=number&expand[]=cvc'],
    ['GET', '/v1/issuing/cards/ic_1?expand%5B0%5D=cvc'],
    ['GET', '/v1/issuing/cards?expand[]=data.number'],
  ];
  for (const [method, path, body, type] of blocked) {
    const res = await call(method, path, body, type);
    assert.equal(res.status, 403, `${method} ${path}`);
    const b = json(res);
    assert.equal(b.error.code, 'blocked_by_proxy');
    assert.equal(b.proxy.executed, 'no');
  }
  assert.equal(stripe.requests.length, 0, 'nothing blocked reached Stripe');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(mod.metrics.snapshot().blocked, blocked.length);

  for (const [method, path, body] of [
    ['GET', '/v1/payouts?limit=5'],
    ['GET', '/v1/webhook_endpoints'],
    ['POST', '/v1/payouts/po_1/cancel'],
    ['POST', '/v1/payouts/po_1', 'metadata[a]=b'],
    ['POST', '/v1/refunds', 'charge=ch_1'],
    ['POST', '/v1/accounts/acct_1', 'metadata[a]=b'],
    ['POST', '/v1/accounts/acct_1/persons', 'first_name=A'],
    ['POST', '/v1/payment_intents', 'amount=100&currency=usd'],
    ['POST', '/v1/checkout/sessions', 'mode=payment'],
    ['DELETE', '/v1/customers/cus_1'],
    ['POST', '/v1/topups', 'amount=100&currency=usd'],
    ['GET', '/v1/issuing/cards/ic_1?expand[]=cardholder'],
    ['POST', '/v1/treasury/debit_reversals', 'received_debit=rd_1'],
  ]) {
    const res = await call(method, path, body);
    assert.equal(res.status, 200, `${method} ${path}`);
  }

  for (const path of ['/v1//payouts', '/v1/payouts%2Fx', '/v1/./payouts', '/v1/payouts;x', '/v1/payouts#x', '/health']) {
    const res = await call('POST', path);
    assert.equal(res.status, 400, path);
    assert.equal(json(res).error.code, 'invalid_path');
  }

  // Account parameters must be written one unambiguous way.
  for (const [path, body] of [
    ['/v1/accounts/acct_1', '[external_account]=btok_1'],
    ['/v1/accounts/acct_1', ']external_account=btok_1'],
    ['/v1/accounts/acct_1', 'metadata[a]=1;external_account=btok_1'],
    ['/v1/accounts/acct_1?a=1;external_account=btok_1', 'metadata[a]=1'],
    ['/v1/accounts', '{"[external_account]":"btok_1"}'],
  ]) {
    const res = await call('POST', path, body, body.startsWith('{') ? 'application/json' : undefined);
    assert.equal(res.status, 400, `${path} ${body}`);
    assert.equal(json(res).error.code, 'ambiguous_params');
  }
  assert.equal(stripe.requests.filter((r) => r.path.startsWith('/v1/accounts')).length, 2, 'only the two harmless account calls reached Stripe');
});

test('with the switches on, money out and access grants are forwarded', async (t) => {
  const { url, stripe, accessKey } = await setup(t, { env: { STRIPE_ALLOW_MONEY_OUT: 'true', STRIPE_ALLOW_ACCESS_GRANTS: 'true' } });
  for (const path of ['/v1/payouts', '/v1/webhook_endpoints']) {
    const res = await request(`${url}/stripe${path}`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/x-www-form-urlencoded', ...ikey() }, body: 'a=b' });
    assert.equal(res.status, 200, path);
  }
  assert.equal(stripe.requests.length, 2);
});

test('only GET, POST and DELETE; bodies over 1 MB are refused', async (t) => {
  const { url, stripe, accessKey } = await setup(t);
  const put = await request(`${url}/stripe/v1/customers/cus_1`, { method: 'PUT', headers: { 'X-Proxy-Key': accessKey } });
  assert.equal(put.status, 405);
  const big = await request(`${url}/stripe/v1/customers`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, 'Content-Type': 'application/x-www-form-urlencoded', ...ikey() }, body: `a=${'x'.repeat(1_100_000)}` });
  assert.equal(big.status, 413);
  assert.equal(stripe.requests.length, 0);
});

test('not configured: /stripe answers 503 and nothing else changes', async (t) => {
  const { url, stripe } = await setup(t, { env: { STRIPE_SECRET_KEY: '' } });
  const res = await request(`${url}/stripe/v1/balance`, { headers: { 'X-Proxy-Key': KEY } });
  assert.equal(res.status, 503);
  assert.equal(json(res).error.code, 'stripe_not_configured');
  assert.equal(stripe.requests.length, 0);
  assert.equal((await request(`${url}/ghl/contacts/`, { headers: { 'X-Proxy-Key': KEY } })).status, 200);
});

test('own rate limit and own activity; logs never hold keys or queries', async (t) => {
  const { url, accessKey, mod, app, logs } = await setup(t, { env: { RATE_LIMIT_MAX: '2' } });
  const get = (headers = {}) => request(`${url}/stripe/v1/customers/search?query=email:%22ana@x.com%22`, { headers: { 'X-Proxy-Key': accessKey, ...headers } });
  assert.equal((await get()).status, 200);
  assert.equal((await get()).status, 200);
  assert.equal((await get()).status, 429);
  assert.equal((await get({ 'X-Stripe-Check': mod.config.checkMarker })).status, 200, 'the panel marker skips the budget');
  assert.equal((await request(`${url}/ghl/contacts/`, { headers: { 'X-Proxy-Key': KEY } })).status, 200, 'GHL has its own budget');
  await new Promise((r) => setTimeout(r, 30));
  const s = mod.metrics.snapshot();
  assert.equal(s.calls, 2);
  assert.equal(s.rateLimited, 1);
  assert.equal(app.locals.metrics.snapshot().calls, 1);
  const text = JSON.stringify(logs);
  for (const secret of [SECRET, accessKey, 'ana@x.com']) assert.ok(!text.includes(secret), 'nothing secret in logs');
});

test('after a lost first attempt, a later error never claims nothing happened', async (t) => {
  const { url, stripe, accessKey } = await setup(t);
  // v1 DELETE has no Idempotency-Key: the lost first attempt may be the one that deleted.
  stripe.script('DELETE /v1/customers/cus_9', ['drop', { status: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such customer' } } }]);
  const del = await request(`${url}/stripe/v1/customers/cus_9`, { method: 'DELETE', headers: { 'X-Proxy-Key': accessKey } });
  assert.equal(del.status, 404);
  assert.equal(json(del).proxy.executed, 'unknown');
  assert.match(json(del).proxy.next, /ya esté hecho/);

  // A conflict that outlasts the proxy's retries: still running at Stripe.
  stripe.script('POST /v1/invoices', Array(3).fill({ status: 409, body: { error: { type: 'invalid_request_error', code: 'idempotency_key_in_use', message: 'in use' } } }));
  const busy = await request(`${url}/stripe/v1/invoices`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, ...ikey() } });
  assert.equal(busy.status, 409);
  assert.equal(json(busy).proxy.executed, 'unknown');
  assert.equal(json(busy).proxy.safe_to_retry, 'same-key');

  // A key reused with other parameters: the original request already ran.
  stripe.script('POST /v1/subscriptions', [{ status: 400, body: { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } } }]);
  const reused = await request(`${url}/stripe/v1/subscriptions`, { method: 'POST', headers: { 'X-Proxy-Key': accessKey, ...ikey() } });
  assert.equal(json(reused).proxy.executed, 'unknown');
  assert.equal(json(reused).proxy.safe_to_retry, 'no');
});

test('error answers that are not JSON still come with the explanation', async (t) => {
  const { url, stripe, accessKey } = await setup(t);
  stripe.script('GET /v1/charges', [{ status: 400, body: 'x' }]);
  const res = await request(`${url}/stripe/v1/charges`, { headers: { 'X-Proxy-Key': accessKey } });
  assert.equal(res.status, 400);
  assert.match(res.headers['content-type'], /json/);
  assert.ok(json(res).proxy.summary);
});

// ---------- panel ----------

async function login(url) {
  const res = await request(`${url}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
  return res.headers['set-cookie'][0].split(';')[0];
}
const adminPost = (url, p, cookie) => request(`${url}/admin/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });

test('panel: overview, key and live checks', async (t) => {
  const { url, accessKey, mod, app, stripe } = await setup(t);
  assert.equal((await request(`${url}/admin/api/stripe/overview`)).status, 401);
  const cookie = await login(url);
  const checks = await adminPost(url, '/stripe/checks', cookie);
  assert.equal(checks.status, 200);
  const c = json(checks);
  const byId = Object.fromEntries(c.checks.map((x) => [x.id, x.status]));
  assert.deepEqual(byId, { config: 'ok', key: 'ok', account: 'ok', scopes: 'ok', proxy: 'ok', auth: 'ok', separate: 'ok', guard: 'ok', money_out: 'ok', access_grants: 'ok' });
  assert.equal(c.overall, 'ok');
  assert.deepEqual(c.account, { id: 'acct_123', name: 'Eximia Test', country: 'US', currency: 'usd', chargesEnabled: true, payoutsEnabled: true });
  assert.ok(!checks.text.includes('secret-owner@example.com'), 'no account e-mail in the panel');
  assert.ok(c.permissions.every((p) => p.state === 'ok'));
  assert.ok(stripe.requests.every((r) => r.method === 'GET'), 'the checks only read from Stripe');

  const o = json(await request(`${url}/admin/api/stripe/overview`, { headers: { Cookie: cookie } }));
  assert.equal(o.configured, true);
  assert.equal(o.mode, 'test');
  assert.equal(o.keyKind, 'restricted');
  assert.match(o.museMessage, /custom\.stripe-proxy/);
  assert.match(o.museMessage, /BLOQUEADOS/);
  assert.match(o.museMessage, /Idempotency-Key/);
  assert.match(o.key.secretHint, /^rk_test_…/);
  const ovText = JSON.stringify(o);
  for (const secret of [SECRET, accessKey, KEY, PIN]) assert.ok(!ovText.includes(secret) && !checks.text.includes(secret));

  assert.equal(json(await adminPost(url, '/stripe/key', cookie)).accessKey, accessKey);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(mod.metrics.snapshot().calls, 0, 'panel checks are not Muse activity');
  assert.equal(mod.metrics.snapshot().rejectedKey, 0);
  assert.equal(app.locals.metrics.snapshot().rejectedKey, 0);
});

test('panel: a full secret key and missing permissions are flagged', async (t) => {
  const { url } = await setup(t, { env: { STRIPE_SECRET_KEY: 'sk_test_otherkey0123456789' }, denied: ['/v1/invoices', '/v1/account'] });
  const cookie = await login(url);
  const c = json(await adminPost(url, '/stripe/checks', cookie));
  // The fake rejects this key, so the key check fails and nothing else is probed.
  assert.equal(c.checks.find((x) => x.id === 'key').status, 'fail');
  assert.equal(c.checks.find((x) => x.id === 'kind').status, 'warn');
});

test('panel: restricted key without some read permissions', async (t) => {
  const { url } = await setup(t, { denied: ['/v1/invoices', '/v1/account'] });
  const cookie = await login(url);
  const c = json(await adminPost(url, '/stripe/checks', cookie));
  assert.equal(c.checks.find((x) => x.id === 'scopes').status, 'warn');
  assert.equal(c.checks.find((x) => x.id === 'account').status, 'ok', 'reading the account is optional');
  assert.match(c.permissions.find((p) => p.id === 'invoices').detail, /Invoices/);
});

test('panel: a passing Stripe hiccup is not reported as a bad key', async (t) => {
  const { url, stripe } = await setup(t);
  stripe.script('GET /v1/balance', [{ status: 503, body: { error: { type: 'api_error', message: 'busy' } } }]);
  const cookie = await login(url);
  const c = json(await adminPost(url, '/stripe/checks', cookie));
  const key = c.checks.find((x) => x.id === 'key');
  assert.equal(key.status, 'warn');
  assert.match(key.detail, /No es un problema de la clave/);
});

test('panel: without the key it shows the setup state', async (t) => {
  const { url } = await setup(t, { env: { STRIPE_SECRET_KEY: '' } });
  const cookie = await login(url);
  const o = json(await request(`${url}/admin/api/stripe/overview`, { headers: { Cookie: cookie } }));
  assert.equal(o.configured, false);
  assert.equal(o.museMessage, null);
  assert.equal((await adminPost(url, '/stripe/key', cookie)).status, 409);
  assert.equal(json(await adminPost(url, '/stripe/checks', cookie)).overall, 'setup');
});

test('panel: without the Stripe module there are no Stripe endpoints', async (t) => {
  const { url } = await setup(t, { withStripe: false });
  const cookie = await login(url);
  assert.equal((await request(`${url}/admin/api/stripe/overview`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await request(`${url}/stripe/v1/balance`, { headers: { 'X-Proxy-Key': KEY } })).status, 404);
});

test('guard: blockedBy ignores the switches it should', () => {
  assert.equal(blockedBy('POST', '/v1/payouts', [], { allowMoneyOut: true, allowAccessGrants: false }), null);
  assert.equal(blockedBy('POST', '/v1/webhook_endpoints', [], { allowMoneyOut: false, allowAccessGrants: true }), null);
  assert.equal(blockedBy('POST', '/v1/webhook_endpoints', [], { allowMoneyOut: true, allowAccessGrants: false }).tier, 'access');
});
