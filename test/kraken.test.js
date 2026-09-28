'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { TOKEN, KEY, request, listen, close } = require('./helpers');
const { createApp } = require('../src/create-app');
const { loadConfig } = require('../src/config');
const { createKraken, tryCreateKraken } = require('../src/kraken');
const { loadKrakenConfig, deriveAccessKey } = require('../src/kraken/config');
const { checkMethod, READ_ONLY, TRADING, NEVER } = require('../src/kraken/methods');
const { sign, createNonceSource, selfTest } = require('../src/kraken/sign');
const { encodeBody, createKrakenClient } = require('../src/kraken/client');

const API_KEY = 'test-kraken-api-key-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';
const SECRET = crypto.randomBytes(64).toString('base64');
const PIN = '24681357';

/** Fake api.kraken.com: checks key, signature and strictly increasing nonces like Kraken does. */
async function startFakeKraken({ handlers = {}, nonceWindow = 0 } = {}) {
  const requests = [];
  let lastNonce = 0n;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const record = { method: req.method, url: req.url, headers: req.headers, body, destroy: () => req.socket.destroy() };
      requests.push(record);
      const json = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      if (req.url === '/0/public/Time') return json(200, { error: [], result: { unixtime: 1 } });
      if (req.method !== 'POST') return json(404, { error: ['EGeneral:Unknown method'] });
      if (req.headers['api-key'] !== API_KEY) return json(200, { error: ['EAPI:Invalid key'] });
      const isJson = /application\/json/.test(req.headers['content-type'] || '');
      const params = isJson ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
      record.params = params;
      const nonce = String(params.nonce);
      const expected = sign({ secret: SECRET, uriPath: req.url, nonce, postData: body });
      if (req.headers['api-sign'] !== expected) return json(200, { error: ['EAPI:Invalid signature'] });
      if (BigInt(nonce) <= lastNonce - BigInt(nonceWindow)) return json(200, { error: ['EAPI:Invalid nonce'] });
      if (BigInt(nonce) > lastNonce) lastNonce = BigInt(nonce);
      const name = req.url.replace('/0/private/', '');
      const handler = handlers[name];
      if (handler) return handler(record, json);
      if (name === 'Balance') return json(200, { error: [], result: { XXBT: '0.5', ZUSD: '100.00' } });
      if (name === 'GetApiKeyInfo') {
        return json(200, {
          error: [],
          result: { apiKeyName: 'muse', apiKey: API_KEY, iban: 'SECRET-IBAN', nonce: nonce, nonceWindow: 10000, permissions: ['query-funds', 'query-open-trades', 'query-closed-trades', 'query-ledger'], validUntil: '0', ipAllowlist: [] },
        });
      }
      return json(200, { error: [], result: { method: name } });
    });
  });
  const url = await listen(server);
  return { url, requests, close: () => close(server) };
}

function makeLogger() {
  const lines = [];
  const push = (level) => (fields) => lines.push({ level, ...fields });
  return { lines, logger: { info: push('info'), warn: push('warn'), error: push('error') } };
}

/** The whole app (GHL + Kraken) with a fake GHL and a fake Kraken. */
async function setup(t, { env = {}, handlers, nonceWindow, withKraken = true } = {}) {
  const kraken = await startFakeKraken({ handlers, nonceWindow });
  const ghl = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ contacts: [], meta: { total: 0 } }));
  });
  const ghlUrl = await listen(ghl);
  const fullEnv = { GHL_TOKEN: TOKEN, PROXY_KEY: KEY, GHL_BASE_URL: ghlUrl, ADMIN_PIN: PIN, KRAKEN_API_KEY: API_KEY, KRAKEN_API_SECRET: SECRET, KRAKEN_BASE_URL: kraken.url, ...env };
  const config = loadConfig(fullEnv);
  const { lines, logger } = makeLogger();
  const mod = withKraken ? createKraken({ env: fullEnv, ghlConfig: config, logger }) : null;
  const app = createApp(config, logger, { kraken: mod });
  const server = http.createServer(app);
  const url = await listen(server);
  app.locals.selfUrl = url;
  t.after(async () => {
    app.locals.limiter.stop();
    if (mod) mod.limiter.stop();
    await close(server);
    await close(ghl);
    await kraken.close();
  });
  return { url, kraken, logs: lines, mod, accessKey: mod && mod.config.accessKey };
}

const call = (url, body, headers = {}) =>
  request(`${url}/api/kraken`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const errorOf = (res) => JSON.parse(res.text).error[0];

// ---------- signing ----------

test('test-sign.js prints PASS against the official Kraken example', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'test-sign.js')], { encoding: 'utf8' });
  assert.match(out, /^PASS/);
  assert.equal(selfTest(), true);
});

test('the proxy body encoding reproduces the official example byte for byte', () => {
  const { body, contentType } = encodeBody({ ordertype: 'limit', pair: 'XBTUSD', price: 37500, type: 'buy', volume: '1.25' }, '1616492376594');
  assert.equal(contentType, 'application/x-www-form-urlencoded');
  assert.equal(body, 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25');
});

test('nonces never repeat or go back, even if the clock does', () => {
  const times = [1000, 1000, 999, 1500, 1500];
  const next = createNonceSource(() => times.shift());
  assert.deepEqual([next(), next(), next(), next(), next()], ['1000', '1001', '1002', '1500', '1501']);
});

// ---------- config & allowlist ----------

test('Kraken config never throws and explains what is missing', () => {
  const empty = loadKrakenConfig({});
  assert.equal(empty.enabled, false);
  assert.equal(empty.started, false);
  assert.ok(empty.problems.some((p) => p.includes('KRAKEN_API_KEY')));
  const bad = loadKrakenConfig({ KRAKEN_API_KEY: API_KEY, KRAKEN_API_SECRET: 'not base64!!' });
  assert.equal(bad.enabled, false);
  assert.equal(bad.started, true);
  assert.ok(bad.problems.some((p) => p.includes('base64')));
  for (const p of bad.problems) assert.ok(!p.includes('not base64'), 'values never appear in messages');
  assert.equal(bad.accessKey, null);
});

test('one access key for Muse, derived from the two Kraken keys (or set explicitly)', () => {
  const a = loadKrakenConfig({ KRAKEN_API_KEY: API_KEY, KRAKEN_API_SECRET: SECRET });
  assert.equal(a.enabled, true);
  assert.equal(a.accessKeySource, 'derived');
  assert.match(a.accessKey, /^[0-9a-f]{64}$/);
  assert.equal(a.accessKey, deriveAccessKey(API_KEY, Buffer.from(SECRET, 'base64')), 'same on every instance');
  assert.ok(!a.accessKey.includes(API_KEY) && !SECRET.includes(a.accessKey));
  const rotated = loadKrakenConfig({ KRAKEN_API_KEY: `${API_KEY}x`, KRAKEN_API_SECRET: SECRET });
  assert.notEqual(rotated.accessKey, a.accessKey);

  const explicit = loadKrakenConfig({ KRAKEN_API_KEY: API_KEY, KRAKEN_API_SECRET: SECRET, KRAKEN_PROXY_KEY: 'k'.repeat(40) });
  assert.equal(explicit.accessKeySource, 'env');
  assert.equal(explicit.accessKey, 'k'.repeat(40));

  const reused = loadKrakenConfig({ KRAKEN_API_KEY: API_KEY, KRAKEN_API_SECRET: SECRET, KRAKEN_PROXY_KEY: KEY }, { ghl: { proxyKey: KEY } });
  assert.equal(reused.enabled, false, 'the GHL key can never open Kraken');
  assert.equal(loadKrakenConfig({ KRAKEN_API_KEY: API_KEY, KRAKEN_API_SECRET: SECRET, KRAKEN_PROXY_KEY: 'short' }).enabled, false);
});

test('ENABLE_TRADING must be exactly "true"', () => {
  for (const value of [undefined, 'false', 'TRUE', '1', ' true', 'true ']) {
    assert.equal(loadKrakenConfig({ ENABLE_TRADING: value }).trading, false, String(value));
  }
  assert.equal(loadKrakenConfig({ ENABLE_TRADING: 'true' }).trading, true);
});

test('allowlist: read-only by default, trading only when enabled, withdrawals never', () => {
  for (const m of READ_ONLY) assert.equal(checkMethod(m, { trading: false }).ok, true, m);
  for (const m of TRADING) {
    assert.equal(checkMethod(m, { trading: false }).ok, false, m);
    assert.equal(checkMethod(m, { trading: true }).ok, true, m);
  }
  for (const m of [...NEVER, 'withdraw', 'WITHDRAW', 'WithdrawAddresses', 'Withdraw ', 'EditOrder', 'balance', '../Withdraw', 'Balance/../Withdraw', '']) {
    const r = checkMethod(m, { trading: true });
    assert.equal(r.ok, false, m);
    assert.equal(r.status, 403, m);
  }
  for (const m of NEVER) assert.ok(!READ_ONLY.includes(m) && !TRADING.includes(m));
  // Its token carries the key's permissions (orders over WebSockets), so it counts as trading.
  assert.equal(checkMethod('GetWebSocketsToken', { trading: false }).ok, false);
});

// ---------- the endpoint ----------

test('health needs no key and says {"ok": true}', async (t) => {
  const { url } = await setup(t);
  const res = await request(`${url}/api/kraken?health=1`);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { ok: true });
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('Balance: signed correctly, and Kraken\'s answer comes back as-is', async (t) => {
  const { url, kraken, accessKey } = await setup(t);
  const res = await call(url, { method: 'Balance', params: {} }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 200);
  assert.equal(res.text, JSON.stringify({ error: [], result: { XXBT: '0.5', ZUSD: '100.00' } }));
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(kraken.requests.length, 1);
  const sent = kraken.requests[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/0/private/Balance');
  assert.equal(sent.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.match(sent.body, /^nonce=\d{13}$/);
  assert.equal(sent.headers['x-proxy-key'], undefined, 'the proxy key never reaches Kraken');
});

test('params are passed through after the nonce', async (t) => {
  const { url, kraken, accessKey } = await setup(t);
  const res = await call(url, { method: 'Ledgers', params: { asset: 'XXBT', start: '1700000000', ofs: 50, without_count: true } }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 200);
  assert.match(kraken.requests[0].body, /^nonce=\d+&asset=XXBT&start=1700000000&ofs=50&without_count=true$/);
});

test('no key, a wrong key or the GHL key: 401 and Kraken is never called', async (t) => {
  const { url, kraken, accessKey } = await setup(t);
  for (const headers of [{}, { 'X-Proxy-Key': 'wrong' }, { 'X-Proxy-Key': KEY }, { 'X-Proxy-Key': `${accessKey}x` }]) {
    const res = await call(url, { method: 'Balance' }, headers);
    assert.equal(res.status, 401);
    assert.deepEqual(JSON.parse(res.text), { error: ['EProxy:Unauthorized'] });
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  assert.equal(kraken.requests.length, 0);
  // ...and the Kraken key does not open GoHighLevel.
  const ghl = await request(`${url}/ghl/contacts/`, { headers: { 'X-Proxy-Key': accessKey } });
  assert.equal(ghl.status, 401);
});

test('Withdraw is refused even with ENABLE_TRADING=true, without touching Kraken', async (t) => {
  const { url, kraken, accessKey } = await setup(t, { env: { ENABLE_TRADING: 'true' } });
  for (const method of ['Withdraw', 'WithdrawCancel', 'WalletTransfer', 'withdraw', 'Earn/Allocate']) {
    const res = await call(url, { method, params: { asset: 'XXBT', key: 'x', amount: '1' } }, { 'X-Proxy-Key': accessKey });
    assert.equal(res.status, 403, method);
    assert.match(errorOf(res), /^EProxy:/);
  }
  assert.equal(kraken.requests.length, 0);
});

test('trading methods: 403 by default, allowed with ENABLE_TRADING=true', async (t) => {
  const off = await setup(t);
  const res = await call(off.url, { method: 'AddOrder', params: { pair: 'XBTUSD', type: 'buy', ordertype: 'market', volume: '0.01' } }, { 'X-Proxy-Key': off.accessKey });
  assert.equal(res.status, 403);
  assert.match(errorOf(res), /Trading is disabled/);
  assert.equal(off.kraken.requests.length, 0);

  const on = await setup(t, { env: { ENABLE_TRADING: 'true' } });
  const ok = await call(on.url, { method: 'AddOrder', params: { pair: 'XBTUSD', type: 'buy', ordertype: 'market', volume: '0.01' } }, { 'X-Proxy-Key': on.accessKey });
  assert.equal(ok.status, 200);
  assert.equal(on.kraken.requests[0].url, '/0/private/AddOrder');
});

test('batch orders go as JSON, signed over the exact JSON body', async (t) => {
  const { url, kraken, accessKey } = await setup(t, { env: { ENABLE_TRADING: 'true' } });
  const orders = [{ ordertype: 'limit', type: 'buy', volume: '0.01', price: '10000' }];
  const res = await call(url, { method: 'AddOrderBatch', params: { pair: 'XBTUSD', orders } }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text).error, [], 'the fake Kraken accepted the signature');
  const sent = kraken.requests[0];
  assert.equal(sent.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(sent.body).orders, orders);
  assert.match(sent.body, /^\{"nonce":\d+,/);
});

test('bad input: 400/403 and Kraken is never called', async (t) => {
  const { url, kraken, accessKey } = await setup(t);
  const h = { 'X-Proxy-Key': accessKey };
  const cases = [
    ['not json', 400],
    ['[]', 400],
    ['null', 400],
    [{ params: {} }, 400],
    [{ method: 42 }, 400],
    [{ method: '' }, 400],
    [{ method: 'Balance', params: [] }, 400],
    [{ method: 'Balance', params: 'x' }, 400],
    [{ method: 'Balance', params: null }, 400],
    [{ method: 'Balance', params: { nonce: '1' } }, 400],
    [{ method: 'Balance', params: { asset: { nested: true } } }, 400],
    [{ method: 'Balance', params: { 'a&b': '1' } }, 400],
    [{ method: 'Balance', params: { asset: null } }, 400],
    [{ method: 'DepositAddresses', params: { asset: 'XBT', method: 'Bitcoin', new: true } }, 403],
    [{ method: 'DepositAddresses', params: { asset: 'XBT', method: 'Bitcoin', new: 'true' } }, 403],
    [{ method: 'DepositAddresses', params: { asset: 'XBT', method: 'Bitcoin', new: false } }, 403],
    [{ method: 'DepositAddresses', params: { asset: 'XBT', method: 'Bitcoin Lightning', amount: '0.1' } }, 403],
    [{ method: 'GetWebSocketsToken' }, 403],
    [{ method: 'NotAMethod' }, 403],
  ];
  for (const [body, status] of cases) {
    const res = await call(url, body, h);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.match(errorOf(res), /^EProxy:/);
  }
  const empty = await request(`${url}/api/kraken`, { method: 'POST', headers: h });
  assert.equal(empty.status, 400);
  assert.equal(kraken.requests.length, 0);

  const allowed = await call(url, { method: 'DepositAddresses', params: { asset: 'XBT', method: 'Bitcoin' } }, h);
  assert.equal(allowed.status, 200);
  assert.doesNotMatch(kraken.requests[0].body, /new|amount/);
});

test('60 requests per minute per IP, then 429 with Retry-After', async (t) => {
  const { url, kraken } = await setup(t);
  for (let i = 0; i < 60; i += 1) {
    const res = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': 'wrong' });
    assert.equal(res.status, 401);
  }
  const limited = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': 'wrong' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal(kraken.requests.length, 0);
});

test('failed attempts from the same IP never use up Muse\'s budget', async (t) => {
  const { url, accessKey } = await setup(t);
  for (let i = 0; i < 61; i += 1) await call(url, { method: 'Balance' }, { 'X-Proxy-Key': 'wrong' });
  const ok = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey });
  assert.equal(ok.status, 200);
  for (let i = 0; i < 59; i += 1) await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey });
  const limited = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey });
  assert.equal(limited.status, 429, 'Muse itself is still limited to 60 per minute');
});

test('the GHL panel marker does not bypass anything on Kraken; only the Kraken one does', async (t) => {
  const { url, accessKey, mod } = await setup(t);
  const ghlMarker = crypto.createHmac('sha256', KEY).update('ghl-proxy admin check v1').digest('hex');
  for (let i = 0; i < 60; i += 1) await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey, 'X-Admin-Check': ghlMarker });
  assert.equal((await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey, 'X-Admin-Check': ghlMarker })).status, 429);
  assert.equal(mod.metrics.snapshot().calls, 60, 'marked calls with the GHL marker still show as Muse activity');
  // The panel's own marker (from the Kraken secret) skips the limit, but only with the right key.
  const marker = { 'X-Kraken-Check': mod.config.checkMarker };
  assert.equal((await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey, ...marker })).status, 200);
  assert.equal((await call(url, { method: 'Balance' }, { 'X-Proxy-Key': 'wrong', ...marker })).status, 401);
  assert.notEqual(mod.config.checkMarker, accessKey);
});

test('a malformed panel marker never causes a 500 (GHL or Kraken)', async (t) => {
  const { url, accessKey } = await setup(t);
  const weird = 'é'.repeat(64);
  const ghl = await request(`${url}/ghl/contacts/`, { headers: { 'X-Proxy-Key': KEY, 'X-Admin-Check': weird } });
  assert.equal(ghl.status, 200);
  const k = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey, 'X-Kraken-Check': weird, 'X-Admin-Check': weird });
  assert.equal(k.status, 200);
});

test('one retry on "Invalid nonce" for reads, none for trading', async (t) => {
  let failFirst = true;
  const handlers = {
    Balance: (record, json) => {
      if (failFirst) {
        failFirst = false;
        return json(200, { error: ['EAPI:Invalid nonce'] });
      }
      return json(200, { error: [], result: {} });
    },
    AddOrder: (record, json) => json(200, { error: ['EAPI:Invalid nonce'] }),
  };
  const { url, kraken, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const read = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey });
  assert.equal(read.status, 200);
  assert.deepEqual(JSON.parse(read.text).error, []);
  assert.equal(kraken.requests.length, 2);
  const nonces = kraken.requests.map((r) => BigInt(r.params.nonce));
  assert.ok(nonces[1] > nonces[0]);

  const trade = await call(url, { method: 'AddOrder', params: { pair: 'XBTUSD' } }, { 'X-Proxy-Key': accessKey });
  assert.deepEqual(JSON.parse(trade.text).error, ['EAPI:Invalid nonce']);
  assert.equal(kraken.requests.length, 3, 'trading calls are never retried');
});

test('simultaneous calls reach Kraken in nonce order (no "Invalid nonce")', async (t) => {
  const { url, kraken, accessKey } = await setup(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey })));
  for (const res of results) assert.deepEqual(JSON.parse(res.text).error, []);
  const nonces = kraken.requests.map((r) => BigInt(r.params.nonce));
  for (let i = 1; i < nonces.length; i += 1) assert.ok(nonces[i] > nonces[i - 1]);
});

test('client: one deadline for the whole call, even if Kraken trickles bytes', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const timer = setInterval(() => res.write(' '), 50);
    res.on('close', () => clearInterval(timer));
  });
  const base = await listen(server);
  t.after(() => close(server));
  const config = loadKrakenConfig({ KRAKEN_API_KEY: API_KEY, KRAKEN_API_SECRET: SECRET, KRAKEN_BASE_URL: base });
  const client = createKrakenClient(config, { timeoutMs: 300 });
  const started = Date.now();
  const res = await client.privateCall('Balance', {}, { readOnly: true });
  assert.equal(res.error, 'timeout');
  assert.ok(Date.now() - started < 2000);
  // The queue is free again.
  const next = await client.privateCall('Balance', {}, { readOnly: true });
  assert.equal(next.error, 'timeout');
});

test('client: a call whose caller hung up is never signed or sent', async (t) => {
  const kraken = await startFakeKraken();
  t.after(() => kraken.close());
  const config = loadKrakenConfig({ KRAKEN_API_KEY: API_KEY, KRAKEN_API_SECRET: SECRET, KRAKEN_BASE_URL: kraken.url });
  const client = createKrakenClient(config);
  const res = await client.privateCall('Balance', {}, { readOnly: true, isCancelled: () => true });
  assert.equal(res.error, 'cancelled');
  assert.equal(kraken.requests.length, 0);
});

test('client: a stale kept-alive socket is retried once for reads', async (t) => {
  let n = 0;
  const handlers = {
    Balance: (record, json) => {
      n += 1;
      if (n === 2) return record.destroy(); // the socket dies before any answer
      return json(200, { error: [], result: {} });
    },
  };
  const kraken = await startFakeKraken({ handlers });
  t.after(() => kraken.close());
  const config = loadKrakenConfig({ KRAKEN_API_KEY: API_KEY, KRAKEN_API_SECRET: SECRET, KRAKEN_BASE_URL: kraken.url });
  const client = createKrakenClient(config);
  assert.deepEqual((await client.privateCall('Balance', {}, { readOnly: true })).json.error, []);
  const second = await client.privateCall('Balance', {}, { readOnly: true });
  assert.equal(second.status, 200);
  assert.equal(second.attempts, 2);
});

test('trading: a lost answer says the order may exist, and is not retried', async (t) => {
  const handlers = { AddOrder: (record) => record.destroy() };
  const { url, kraken, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const res = await call(url, { method: 'AddOrder', params: { pair: 'XBTUSD' } }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 502);
  assert.match(errorOf(res), /may or may not have been placed/);
  assert.equal(kraken.requests.length, 1);
});

test('Kraken down or not JSON: 502 with an EProxy error', async (t) => {
  const handlers = { Balance: (record, json) => json(502, '<html>Bad gateway</html>') };
  const { url, accessKey } = await setup(t, { handlers });
  const res = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 502);
  assert.match(errorOf(res), /^EProxy:/);
});

test('other verbs and paths answer as Kraken errors, not as GHL', async (t) => {
  const { url } = await setup(t);
  const get = await request(`${url}/api/kraken`);
  assert.equal(get.status, 405);
  const sub = await request(`${url}/api/kraken/Balance`, { method: 'POST' });
  assert.equal(sub.status, 404);
  assert.match(errorOf(sub), /^EProxy:/);
});

test('logs never contain keys, signatures or params', async (t) => {
  const { url, kraken, logs, accessKey } = await setup(t);
  await call(url, { method: 'Ledgers', params: { asset: 'SENSITIVE-PARAM' } }, { 'X-Proxy-Key': accessKey });
  await call(url, { method: 'Balance' }, { 'X-Proxy-Key': 'wrong-key-attempt' });
  const text = JSON.stringify(logs);
  const signature = kraken.requests[0].headers['api-sign'];
  for (const secret of [accessKey, API_KEY, SECRET, signature, 'SENSITIVE-PARAM', 'wrong-key-attempt', kraken.requests[0].body]) {
    assert.ok(!text.includes(secret), 'log leaked a secret or param');
  }
  assert.ok(logs.some((l) => l.msg === 'kraken_call' && l.method === 'Ledgers'));
});

test('without Kraken settings: GHL works exactly as before, Kraken says 503', async (t) => {
  const env = { KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '' };
  const { url } = await setup(t, { env });
  const ghl = await request(`${url}/ghl/contacts/`, { headers: { 'X-Proxy-Key': KEY } });
  assert.equal(ghl.status, 200);
  assert.equal((await request(`${url}/health`)).status, 200);
  const health = await request(`${url}/api/kraken?health=1`);
  assert.equal(health.status, 503);
  const res = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': KEY });
  assert.equal(res.status, 503);
});

test('tryCreateKraken never throws', () => {
  const { logger } = makeLogger();
  assert.equal(tryCreateKraken({ env: {}, ghlConfig: null, logger }).config.enabled, false);
  assert.equal(tryCreateKraken({ env: { KRAKEN_BASE_URL: '::bad' }, logger }).config.enabled, false);
});

// ---------- panel ----------

async function login(url) {
  const res = await request(`${url}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }) });
  return res.headers['set-cookie'][0].split(';')[0];
}

const adminPost = (url, p, cookie) =>
  request(`${url}/admin/api${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });

test('panel: Kraken overview, key and live checks', async (t) => {
  const { url, accessKey, mod } = await setup(t);
  assert.equal((await request(`${url}/admin/api/kraken/overview`)).status, 401);
  assert.equal((await adminPost(url, '/kraken/key', '')).status, 401);
  const cookie = await login(url);

  const overview = await request(`${url}/admin/api/kraken/overview`, { headers: { Cookie: cookie } });
  assert.equal(overview.status, 200);
  const o = JSON.parse(overview.text);
  assert.equal(o.configured, true);
  assert.equal(o.trading, false);
  assert.deepEqual(o.methods.allowed, READ_ONLY);
  for (const secret of [accessKey, API_KEY, SECRET]) assert.ok(!overview.text.includes(secret), 'overview leaks no secret');
  assert.match(o.museMessage, /api\/kraken/);
  assert.match(o.museMessage, /X-Proxy-Key/);

  const key = await adminPost(url, '/kraken/key', cookie);
  assert.equal(JSON.parse(key.text).accessKey, accessKey);

  const checks = await adminPost(url, '/kraken/checks', cookie);
  assert.equal(checks.status, 200);
  const c = JSON.parse(checks.text);
  const byId = Object.fromEntries(c.checks.map((x) => [x.id, x.status]));
  assert.deepEqual(byId, { config: 'ok', signature: 'ok', reachable: 'ok', keys: 'ok', auth: 'ok', withdraw: 'ok', proxy: 'ok', trading: 'ok' });
  assert.equal(c.overall, 'ok');
  assert.ok(!checks.text.includes('SECRET-IBAN'), 'the IBAN is never passed on');
  assert.ok(c.key.permissions.every((p) => p.state === 'ok'));
  // The panel's own test calls are not Muse's activity.
  assert.equal(mod.metrics.snapshot().calls, 0);
});

test('panel: key with withdraw permission is flagged', async (t) => {
  const handlers = {
    GetApiKeyInfo: (record, json) =>
      json(200, { error: [], result: { apiKeyName: 'k', permissions: ['query-funds', 'withdraw-funds', 'modify-trades'], nonceWindow: 0, validUntil: '0', ipAllowlist: [] } }),
  };
  const { url } = await setup(t, { handlers });
  const cookie = await login(url);
  const c = JSON.parse((await adminPost(url, '/kraken/checks', cookie)).text);
  const perms = Object.fromEntries(c.key.permissions.map((p) => [p.id, p.state]));
  assert.equal(c.checks.find((x) => x.id === 'keys').status, 'fail');
  assert.equal(c.overall, 'fail', 'a key that can withdraw is never shown as green');
  assert.equal(perms['withdraw-funds'], 'fail');
  assert.equal(perms['modify-trades'], 'warn');
  assert.equal(perms['query-ledger'], 'warn');
  assert.equal(c.key.notes.find((n) => n.label === 'Nonce window').state, 'warn');
});

test('panel: with keys Kraken rejects, no second signed call is made', async (t) => {
  const handlers = { GetApiKeyInfo: (record, json) => json(200, { error: ['EAPI:Invalid key'] }) };
  const { url, kraken } = await setup(t, { handlers });
  const cookie = await login(url);
  const c = JSON.parse((await adminPost(url, '/kraken/checks', cookie)).text);
  assert.equal(c.checks.find((x) => x.id === 'keys').status, 'fail');
  assert.equal(c.checks.find((x) => x.id === 'auth').status, 'ok');
  assert.equal(c.checks.find((x) => x.id === 'withdraw').status, 'ok');
  assert.equal(kraken.requests.filter((r) => r.url.startsWith('/0/private/')).length, 1);
});

test('panel: without Kraken settings it shows the setup state', async (t) => {
  const { url } = await setup(t, { env: { KRAKEN_API_KEY: '', KRAKEN_API_SECRET: '' } });
  const cookie = await login(url);
  const o = JSON.parse((await request(`${url}/admin/api/kraken/overview`, { headers: { Cookie: cookie } })).text);
  assert.equal(o.configured, false);
  assert.equal(o.museMessage, null);
  assert.equal((await adminPost(url, '/kraken/key', cookie)).status, 409);
  const c = JSON.parse((await adminPost(url, '/kraken/checks', cookie)).text);
  assert.equal(c.overall, 'setup');
});

test('without the Kraken module the panel has no Kraken endpoints', async (t) => {
  const { url } = await setup(t, { withKraken: false });
  const cookie = await login(url);
  assert.equal((await request(`${url}/admin/api/kraken/overview`, { headers: { Cookie: cookie } })).status, 404);
  const res = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': KEY });
  assert.notEqual(res.status, 200);
});
