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

/**
 * Fake api.kraken.com: checks key, signature and strictly increasing nonces like Kraken does,
 * and keeps a small order book so order lookups (OpenOrders, ClosedOrders, QueryOrders) work.
 * `handlers[name](record, json, fake)` overrides a method; `fake.place(params)` adds an order.
 */
async function startFakeKraken({ handlers = {}, nonceWindow = 0, systemStatus = 'online' } = {}) {
  const requests = [];
  let lastNonce = 0n;
  const book = new Map();
  let seq = 0;
  const fake = {
    book,
    place(p) {
      seq += 1;
      const txid = `O${String(seq).padStart(5, '0')}-ABCDE-FGHIJK`;
      const market = p.ordertype === 'market';
      book.set(txid, {
        status: market ? 'closed' : 'open',
        opentm: Date.now() / 1000,
        cl_ord_id: p.cl_ord_id ?? null,
        userref: p.userref !== undefined ? Number(p.userref) : null,
        vol: String(p.volume),
        vol_exec: market ? String(p.volume) : '0.00000000',
        price: market ? '27000.0' : '0.00000',
        reason: null,
        descr: { pair: p.pair, type: p.type, ordertype: p.ordertype, price: p.price ?? '0', order: `${p.type} ${p.volume} ${p.pair} @ ${p.ordertype}` },
      });
      return txid;
    },
  };
  const pick = (want) => Object.fromEntries([...book].filter(([, o]) => want(o)));
  const byId = (p) => (o) => p.cl_ord_id === undefined || o.cl_ord_id === p.cl_ord_id;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const record = { method: req.method, url: req.url, headers: req.headers, body, destroy: () => req.socket.destroy() };
      requests.push(record);
      const json = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'x-trace-id': 'trace-123' });
        res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };
      if (req.url === '/0/public/Time') return json(200, { error: [], result: { unixtime: 1 } });
      if (req.url === '/0/public/SystemStatus') return json(200, { error: [], result: { status: systemStatus, timestamp: new Date().toISOString() } });
      if (req.url.startsWith('/0/public/AssetPairs')) {
        return json(200, { error: [], result: { XXBTZUSD: { altname: 'XBTUSD', status: 'online', ordermin: '0.00005', costmin: '0.5', tick_size: '0.1', lot_decimals: 8, pair_decimals: 1 } } });
      }
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
      record.name = name;
      const handler = handlers[name];
      if (handler) return handler(record, json, fake);
      switch (name) {
        case 'Balance':
          return json(200, { error: [], result: { XXBT: '0.5', ZUSD: '100.00' } });
        case 'GetApiKeyInfo':
          return json(200, {
            error: [],
            result: { apiKeyName: 'muse', apiKey: API_KEY, iban: 'SECRET-IBAN', nonce, nonceWindow: 10000, permissions: ['query-funds', 'query-open-trades', 'query-closed-trades', 'query-ledger'], validUntil: '0', ipAllowlist: [] },
          });
        case 'AddOrder':
          if (params.validate) return json(200, { error: [], result: { descr: { order: `${params.type} ${params.volume} ${params.pair}` } } });
          return json(200, { error: [], result: { descr: { order: 'ok' }, txid: [fake.place(params)] } });
        case 'AddOrderBatch':
          if (params.validate) return json(200, { error: [], result: { orders: params.orders.map(() => ({ descr: { order: 'ok' } })) } });
          return json(200, { error: [], result: { orders: params.orders.map((o) => ({ txid: fake.place({ ...o, pair: params.pair }), descr: { order: 'ok' } })) } });
        case 'OpenOrders':
          return json(200, { error: [], result: { open: pick((o) => (o.status === 'open' || o.status === 'pending') && byId(params)(o)) } });
        case 'ClosedOrders':
          return json(200, { error: [], result: { closed: pick((o) => ['closed', 'canceled', 'expired'].includes(o.status) && byId(params)(o)) } });
        case 'QueryOrders':
          return json(200, { error: [], result: Object.fromEntries(String(params.txid).split(',').filter((t) => book.has(t)).map((t) => [t, book.get(t)])) });
        case 'CancelOrder': {
          const hit = [...book].find(([t, o]) => (t === params.txid || (params.cl_ord_id && o.cl_ord_id === params.cl_ord_id)) && o.status === 'open');
          if (!hit) return json(200, { error: ['EOrder:Unknown order'] });
          hit[1].status = 'canceled';
          hit[1].reason = 'User requested';
          return json(200, { error: [], result: { count: 1 } });
        }
        case 'AmendOrder': {
          const o = book.get(params.txid);
          if (!o || o.status !== 'open') return json(200, { error: ['EOrder:Unknown order'] });
          if (params.order_qty) o.vol = params.order_qty;
          return json(200, { error: [], result: { amend_id: 'TEST-AMEND' } });
        }
        default:
          return json(200, { error: [], result: { method: name } });
      }
    });
  });
  const url = await listen(server);
  return { url, requests, fake, close: () => close(server) };
}

function makeLogger() {
  const lines = [];
  const push = (level) => (fields) => lines.push({ level, ...fields });
  return { lines, logger: { info: push('info'), warn: push('warn'), error: push('error') } };
}

/** The whole app (GHL + Kraken) with a fake GHL and a fake Kraken. */
async function setup(t, { env = {}, handlers, nonceWindow, systemStatus, withKraken = true, clientOptions } = {}) {
  const kraken = await startFakeKraken({ handlers, nonceWindow, systemStatus });
  const ghl = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ contacts: [], meta: { total: 0 } }));
  });
  const ghlUrl = await listen(ghl);
  const fullEnv = { GHL_TOKEN: TOKEN, PROXY_KEY: KEY, GHL_BASE_URL: ghlUrl, ADMIN_PIN: PIN, KRAKEN_API_KEY: API_KEY, KRAKEN_API_SECRET: SECRET, KRAKEN_BASE_URL: kraken.url, ...env };
  const config = loadConfig(fullEnv);
  const { lines, logger } = makeLogger();
  // Order checks after a lost answer wait 2 s and 3 s in production; no need to wait in tests.
  const mod = withKraken ? createKraken({ env: fullEnv, ghlConfig: config, logger, clientOptions, executorOptions: { sleep: () => Promise.resolve() } }) : null;
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
const proxyOf = (res) => JSON.parse(res.text).proxy;
const privateCalls = (kraken, name) => kraken.requests.filter((r) => r.name === name);

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
    assert.deepEqual(JSON.parse(res.text).error, ['EProxy:Unauthorized']);
    assert.equal(proxyOf(res).where, 'proxy');
    assert.match(proxyOf(res).summary, /No se envió nada a Kraken/);
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
  const orders = [
    { ordertype: 'limit', type: 'buy', volume: '0.01', price: '10000', cl_ord_id: 'batch-a' },
    { ordertype: 'limit', type: 'buy', volume: 0.02, price: '9000', userref: 7 },
  ];
  const res = await call(url, { method: 'AddOrderBatch', params: { pair: 'XBTUSD', orders } }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text).error, [], 'the fake Kraken accepted the signature');
  const sent = privateCalls(kraken, 'AddOrderBatch')[0];
  assert.equal(sent.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(sent.body).orders, [orders[0], { ...orders[1], volume: '0.02' }], 'decimals go as strings');
  assert.match(sent.body, /^\{"nonce":\d+,/);
  const p = proxyOf(res);
  assert.equal(p.executed, 'yes');
  assert.deepEqual(p.orders.map((o) => [o.placed, o.status]), [['yes', 'open'], ['yes', 'open']]);
  assert.equal(p.orders[0].cl_ord_id, 'batch-a');
  assert.equal(p.orders[1].userref, 7);
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

test('"Invalid nonce" is retried with a fresh nonce, for reads and orders (Kraken ran nothing)', async (t) => {
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

  const trade = await call(url, { method: 'AddOrder', params: { pair: 'XBTUSD', type: 'buy', ordertype: 'limit', price: '1000', volume: '0.001' } }, { 'X-Proxy-Key': accessKey });
  assert.deepEqual(JSON.parse(trade.text).error, ['EAPI:Invalid nonce']);
  const tries = privateCalls(kraken, 'AddOrder');
  assert.equal(tries.length, 3, 'at most 2 retries');
  assert.equal(new Set(tries.map((r) => r.params.cl_ord_id)).size, 1, 'every try carries the same cl_ord_id');
  const p = proxyOf(trade);
  assert.equal(p.executed, 'no');
  assert.equal(p.retry.automaticRetries, 2);
  assert.equal(privateCalls(kraken, 'OpenOrders').length, 0, 'a certain "not executed" needs no lookup');
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
  const policies = { read: { budgetMs: 1500, fresh: false }, cancel: { budgetMs: 1500, fresh: false }, create: { budgetMs: 1500, fresh: true } };
  const client = createKrakenClient(config, { timeoutMs: 300, policies });
  const started = Date.now();
  const res = await client.privateCall('Balance', {});
  assert.equal(res.error, 'timeout');
  assert.ok(Date.now() - started < 2000);
  // The queue is free again.
  const next = await client.privateCall('Balance', {});
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
  assert.deepEqual((await client.privateCall('Balance', {})).json.error, []);
  const started = Date.now();
  const second = await client.privateCall('Balance', {});
  assert.equal(second.status, 200);
  assert.equal(second.attempts.length, 2);
  assert.ok(Date.now() - started < 900, 'a stale socket is retried right away');
});

const ORDER = { pair: 'XBTUSD', type: 'buy', ordertype: 'limit', price: '1000', volume: '0.001' };

test('order answer lost, but it WAS placed: the proxy finds it and says so (never resends)', async (t) => {
  const handlers = {
    AddOrder: (record, json, fake) => {
      fake.place(record.params);
      record.destroy(); // Kraken took it, the answer never arrives
    },
  };
  const { url, kraken, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const res = await call(url, { method: 'AddOrder', params: ORDER }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 502);
  assert.match(errorOf(res), /the order WAS placed/);
  const p = proxyOf(res);
  assert.equal(p.executed, 'yes');
  assert.match(p.summary, /SÍ se creó/);
  assert.match(p.order.txid, /^O\d{5}-ABCDE-FGHIJK$/);
  assert.equal(p.order.status, 'open');
  assert.equal(p.retry.safeToRetry, 'no');
  assert.equal(privateCalls(kraken, 'AddOrder').length, 1, 'an order with an unknown outcome is never resent');
  assert.equal(p.order.cl_ord_id, privateCalls(kraken, 'AddOrder')[0].params.cl_ord_id);
});

test('order answer lost and not found afterwards: said plainly, never as a certain "no"', async (t) => {
  const handlers = { AddOrder: (record) => record.destroy() };
  const { url, kraken, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const res = await call(url, { method: 'AddOrder', params: ORDER }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 502);
  const p = proxyOf(res);
  assert.equal(p.executed, 'unknown', 'Kraken could still process a late order');
  assert.match(p.summary, /NO aparece/);
  assert.equal(p.retry.safeToRetry, 'check-first');
  assert.equal(p.retry.afterSeconds, 60);
  const id = privateCalls(kraken, 'AddOrder')[0].params.cl_ord_id;
  assert.ok(p.next.includes(id), 'Muse is told which cl_ord_id to look for and reuse');
  assert.match(p.next, /no protege si la primera ya se ejecutó/);
  assert.equal(p.order.cl_ord_id, id);
  assert.equal(p.order.seen, false);
  assert.equal(p.verification.conclusive, true);
  assert.equal(privateCalls(kraken, 'AddOrder').length, 1);
  // One order: the lookups use its cl_ord_id as filter.
  assert.equal(privateCalls(kraken, 'OpenOrders')[0].params.cl_ord_id, id);
  assert.equal(privateCalls(kraken, 'ClosedOrders')[0].params.cl_ord_id, id);
});

test('order answer lost and the lookup fails too: "unknown", do not resend', async (t) => {
  const handlers = {
    AddOrder: (record) => record.destroy(),
    OpenOrders: (record, json) => json(200, { error: ['EService:Unavailable'] }),
  };
  const { url, kraken, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const res = await call(url, { method: 'AddOrder', params: ORDER }, { 'X-Proxy-Key': accessKey });
  const p = proxyOf(res);
  assert.equal(p.executed, 'unknown');
  assert.equal(p.retry.safeToRetry, 'check-first');
  assert.match(errorOf(res), /may or may not have been placed/);
  assert.equal(privateCalls(kraken, 'AddOrder').length, 1);
});

test('order sent to a Kraken that cannot be reached: retried, then "not executed" for sure', async (t) => {
  const dead = http.createServer();
  const deadUrl = await listen(dead);
  await close(dead); // nothing listens there any more: connections are refused
  const { url, accessKey } = await setup(t, { env: { ENABLE_TRADING: 'true', KRAKEN_BASE_URL: deadUrl } });
  const res = await call(url, { method: 'AddOrder', params: ORDER }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 502);
  const p = proxyOf(res);
  assert.equal(p.executed, 'no');
  assert.equal(p.retry.automaticRetries, 2);
  assert.match(p.summary, /no llegó a salir del proxy/);
});

test('successful order: txid, cl_ord_id and its state right after', async (t) => {
  const { url, kraken, accessKey } = await setup(t, { env: { ENABLE_TRADING: 'true' } });
  const res = await call(url, { method: 'AddOrder', params: { ...ORDER, volume: 1e-7 } }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.deepEqual(body.error, []);
  assert.equal(body.result.txid.length, 1, "Kraken's own result is kept");
  const sent = privateCalls(kraken, 'AddOrder')[0].params;
  assert.equal(sent.volume, '0.0000001', 'numbers go out as plain decimals');
  assert.match(sent.cl_ord_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const p = body.proxy;
  assert.equal(p.ok, true);
  assert.equal(p.executed, 'yes');
  assert.equal(p.order.status, 'open');
  assert.equal(p.order.cl_ord_id, sent.cl_ord_id);
  assert.match(p.summary, /Orden creada en Kraken/);
  assert.ok(p.changes.some((c) => c.includes('cl_ord_id')));
});

test('validate=false is never sent (Kraken would only validate); validate=true says NOT placed', async (t) => {
  const { url, kraken, accessKey } = await setup(t, { env: { ENABLE_TRADING: 'true' } });
  const res = await call(url, { method: 'AddOrder', params: { ...ORDER, validate: false } }, { 'X-Proxy-Key': accessKey });
  assert.equal(privateCalls(kraken, 'AddOrder')[0].params.validate, undefined);
  assert.equal(proxyOf(res).executed, 'yes');
  assert.ok(proxyOf(res).changes.some((c) => c.startsWith('validate=false')));

  const dry = await call(url, { method: 'AddOrder', params: { ...ORDER, validate: true } }, { 'X-Proxy-Key': accessKey });
  assert.equal(privateCalls(kraken, 'AddOrder')[1].params.validate, 'true');
  assert.equal(proxyOf(dry).executed, 'no');
  assert.match(proxyOf(dry).summary, /Solo se validó/);
});

test('cl_ord_id and userref: checked before sending', async (t) => {
  const { url, kraken, accessKey } = await setup(t, { env: { ENABLE_TRADING: 'true' } });
  for (const extra of [{ cl_ord_id: 'a', userref: 1 }, { cl_ord_id: 'this-text-is-longer-than-18' }, { userref: 1.5 }]) {
    const res = await call(url, { method: 'AddOrder', params: { ...ORDER, ...extra } }, { 'X-Proxy-Key': accessKey });
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.equal(proxyOf(res).executed, 'no');
  }
  assert.equal(privateCalls(kraken, 'AddOrder').length, 0);
  const own = await call(url, { method: 'AddOrder', params: { ...ORDER, userref: 42 } }, { 'X-Proxy-Key': accessKey });
  assert.equal(proxyOf(own).order.userref, 42);
  assert.equal(privateCalls(kraken, 'AddOrder')[0].params.cl_ord_id, undefined, 'no cl_ord_id added when Muse uses userref');
});

test('Kraken rejects an order: plain explanation, "not executed", the pair rules', async (t) => {
  const handlers = { AddOrder: (record, json) => json(200, { error: ['EOrder:Order minimum not met'] }) };
  const { url, kraken, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const res = await call(url, { method: 'AddOrder', params: ORDER }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text).error, ['EOrder:Order minimum not met']);
  const p = proxyOf(res);
  assert.equal(p.executed, 'no');
  assert.equal(p.retry.safeToRetry, 'no');
  assert.match(p.summary, /por debajo del mínimo/);
  assert.match(p.summary, /volumen mínimo 0\.00005/);
  assert.equal(p.pair.ordermin, '0.00005');
  assert.equal(privateCalls(kraken, 'AddOrder').length, 1);
  assert.equal(privateCalls(kraken, 'OpenOrders').length, 0);
});

test('batch with a rejected order: which were placed and which not', async (t) => {
  const handlers = {
    AddOrderBatch: (record, json, fake) =>
      json(200, { error: [], result: { orders: [{ txid: fake.place({ ...record.params.orders[0], pair: 'XBTUSD' }), descr: { order: 'ok' } }, { error: 'EOrder:Insufficient funds' }] } }),
  };
  const { url, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const orders = [{ ordertype: 'limit', type: 'buy', volume: '0.01', price: '1000' }, { ordertype: 'limit', type: 'buy', volume: '50', price: '1000' }];
  const res = await call(url, { method: 'AddOrderBatch', params: { pair: 'XBTUSD', orders } }, { 'X-Proxy-Key': accessKey });
  const p = proxyOf(res);
  assert.equal(p.executed, 'partial');
  assert.equal(p.orders[0].placed, 'yes');
  assert.equal(p.orders[1].placed, 'no');
  assert.match(p.orders[1].explanation, /saldo/);
  assert.match(p.summary, /1 de 2/);
});

test('cancel of an order that already filled: the proxy says it filled', async (t) => {
  const { url, kraken, accessKey } = await setup(t, { env: { ENABLE_TRADING: 'true' } });
  const txid = kraken.fake.place({ ...ORDER, ordertype: 'market' });
  const res = await call(url, { method: 'CancelOrder', params: { txid } }, { 'X-Proxy-Key': accessKey });
  const p = proxyOf(res);
  assert.equal(p.krakenError, 'EOrder:Unknown order');
  assert.equal(p.executed, 'no');
  assert.equal(p.order.status, 'closed');
  assert.match(p.summary, /ejecutada/);
});

test('Temporary lockout: calls pause instead of extending it', async (t) => {
  const handlers = { Balance: (record, json) => json(200, { error: ['EGeneral:Temporary lockout'] }) };
  const { url, kraken, accessKey } = await setup(t, { handlers });
  const first = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey });
  assert.equal(proxyOf(first).retry.afterSeconds, 900);
  const second = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey });
  assert.equal(second.status, 503);
  assert.match(proxyOf(second).summary, /no le llama hasta las/);
  assert.equal(privateCalls(kraken, 'Balance').length, 1, 'nothing was sent during the pause');
});

test('maintenance: reads stop retrying and Muse is told why', async (t) => {
  const handlers = { Balance: (record, json) => json(200, { error: ['EService:Unavailable'] }) };
  const { url, kraken, accessKey } = await setup(t, { handlers, systemStatus: 'maintenance' });
  const res = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey });
  const p = proxyOf(res);
  assert.equal(p.krakenStatus, 'maintenance');
  assert.match(p.summary, /mantenimiento/);
  assert.equal(privateCalls(kraken, 'Balance').length, 1);
});

test('warnings ("W...") are not errors: the answer passes through untouched', async (t) => {
  const handlers = { Balance: (record, json) => json(200, { error: ['WGeneral:Something to note'], result: { ZUSD: '1' } }) };
  const { url, accessKey } = await setup(t, { handlers });
  const res = await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { error: ['WGeneral:Something to note'], result: { ZUSD: '1' } });
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
  assert.deepEqual(byId, { config: 'ok', signature: 'ok', reachable: 'ok', status: 'ok', keys: 'ok', auth: 'ok', withdraw: 'ok', proxy: 'ok', trading: 'ok' });
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

// ---------- retry rules and error catalog ----------

test('retry rules: orders are repeated only when Kraken certainly did not run them', () => {
  const { retryWait } = require('../src/kraken/client');
  const k = (err) => ({ status: 200, json: { error: [err] } });
  const big = 60_000;
  // Rejected before execution: safe for everything.
  assert.ok(retryWait('create', 'AddOrder', k('EAPI:Invalid nonce'), 1, big, 0) >= 300);
  assert.equal(retryWait('create', 'AddOrder', k('EAPI:Invalid nonce'), 3, big, 0), null, 'at most 2 retries');
  assert.equal(retryWait('create', 'AddOrder', k('EOrder:Rate limit exceeded'), 1, big, 0), 2000);
  assert.equal(retryWait('read', 'Balance', k('EOrder:Rate limit exceeded'), 1, big, 0), null);
  assert.equal(retryWait('read', 'Balance', k('EAPI:Rate limit exceeded'), 1, big, 0), 4000);
  assert.equal(retryWait('read', 'Ledgers', k('EAPI:Rate limit exceeded'), 1, big, 0), 13_000);
  assert.equal(retryWait('read', 'Balance', k('EService: Throttled: 1790563500'), 1, big, 1_790_563_498_000), 2250);
  // Ambiguous for orders: never repeated (the proxy looks the order up instead).
  for (const err of ['EService:Unavailable', 'EService:Busy', 'EService:Deadline elapsed', 'EGeneral:Internal error']) {
    assert.equal(retryWait('create', 'AddOrder', k(err), 1, big, 0), null, err);
    assert.equal(retryWait('read', 'Balance', k(err), 1, big, 0), 1000, err);
    assert.equal(retryWait('cancel', 'CancelOrder', k(err), 1, big, 0), 1000, err);
  }
  assert.equal(retryWait('create', 'AddOrder', { status: 0, error: 'timeout' }, 1, big, 0), null);
  assert.equal(retryWait('create', 'AddOrder', { status: 0, error: 'network' }, 1, big, 0), null);
  assert.equal(retryWait('create', 'AddOrder', { status: 502, text: '<html>' }, 1, big, 0), null);
  assert.equal(retryWait('read', 'Balance', { status: 502, text: '<html>' }, 1, big, 0), 1000);
  // Never left the proxy / never reached Kraken: safe to repeat.
  assert.equal(retryWait('create', 'AddOrder', { status: 0, error: 'network', notSent: true }, 1, big, 0), 1000);
  assert.equal(retryWait('create', 'AddOrder', { status: 521, text: 'cf' }, 1, big, 0), 1000);
  // Final errors: never.
  for (const err of ['EOrder:Insufficient funds', 'EAPI:Invalid key', 'EGeneral:Invalid arguments:volume', 'EGeneral:Permission denied', 'EGeneral:Temporary lockout']) {
    assert.equal(retryWait('read', 'Balance', k(err), 1, big, 0), null, err);
  }
  // Waits that do not fit the time left are not attempted.
  assert.equal(retryWait('read', 'Ledgers', k('EAPI:Rate limit exceeded'), 1, 5000, 0), null);
});

test('error catalog: tolerant matching, details kept, unknown errors are "maybe"', () => {
  const { lookupError, CATALOG } = require('../src/kraken/errors');
  assert.equal(lookupError('EGeneral: Invalid arguments:ordertype').detail, 'ordertype');
  assert.equal(lookupError('EGeneral:Invalid arguments:volume').code, 'EGeneral:Invalid arguments:volume');
  assert.equal(lookupError('EGeneral:Unknown Method').code, 'EGeneral:Unknown method');
  assert.equal(lookupError('EService:Market in reduce_only mode').code, 'EService:Market in');
  assert.equal(lookupError('ENew:Never seen').executed, 'maybe');
  for (const e of CATALOG) {
    assert.ok(e.es && e.next && ['no', 'maybe'].includes(e.executed), e.code);
    assert.equal(lookupError(e.code).code, e.code, `${e.code} finds itself`);
  }
});

test('panel: with trading on, a validate-only test order proves the order path', async (t) => {
  const { url, kraken } = await setup(t, { env: { ENABLE_TRADING: 'true' } });
  const cookie = await login(url);
  const c = JSON.parse((await adminPost(url, '/kraken/checks', cookie)).text);
  const orders = c.checks.find((x) => x.id === 'orders');
  assert.equal(orders.status, 'ok');
  const sent = privateCalls(kraken, 'AddOrder');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.validate, 'true', 'the test order is validate-only');
  assert.equal(kraken.fake.book.size, 0, 'nothing was created');
});

test('panel: if Kraken ever created the test order, it is cancelled at once', async (t) => {
  const handlers = { AddOrder: (record, json, fake) => json(200, { error: [], result: { descr: { order: 'x' }, txid: [fake.place({ ...record.params, validate: undefined })] } }) };
  const { url, kraken } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const cookie = await login(url);
  const c = JSON.parse((await adminPost(url, '/kraken/checks', cookie)).text);
  const orders = c.checks.find((x) => x.id === 'orders');
  assert.equal(orders.status, 'fail');
  assert.match(orders.detail, /ya la canceló/);
  assert.equal([...kraken.fake.book.values()][0].status, 'canceled');
});

test('panel: Kraken maintenance and a lockout pause are shown', async (t) => {
  const handlers = { Balance: (record, json) => json(200, { error: ['EGeneral:Temporary lockout'] }) };
  const { url, accessKey } = await setup(t, { handlers, systemStatus: 'maintenance' });
  await call(url, { method: 'Balance' }, { 'X-Proxy-Key': accessKey });
  const cookie = await login(url);
  const c = JSON.parse((await adminPost(url, '/kraken/checks', cookie)).text);
  assert.equal(c.checks.find((x) => x.id === 'status').status, 'fail');
  assert.equal(c.checks.find((x) => x.id === 'lockout').status, 'fail');
  assert.equal(c.checks.find((x) => x.id === 'keys'), undefined, 'no signed calls while paused');
});

// ---------- fixes from the second review ----------

test('userref lookups never match a different order', async (t) => {
  const handlers = {
    AddOrder: (record, json, fake) => {
      if (record.params.price === '1000') return json(200, { error: [], result: { descr: { order: 'A' }, txid: [fake.place(record.params)] } });
      return record.destroy(); // B: answer lost, never placed
    },
  };
  const { url, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  await call(url, { method: 'AddOrder', params: { ...ORDER, userref: 42 } }, { 'X-Proxy-Key': accessKey });
  const b = await call(url, { method: 'AddOrder', params: { ...ORDER, price: '1100', userref: 42 } }, { 'X-Proxy-Key': accessKey });
  const p = proxyOf(b);
  assert.notEqual(p.executed, 'yes', 'order A must not be taken for order B');
  assert.match(p.next, /userref Kraken no evita duplicados/);
});

test('userref 0 and repeated batch ids are refused before sending', async (t) => {
  const { url, kraken, accessKey } = await setup(t, { env: { ENABLE_TRADING: 'true' } });
  const zero = await call(url, { method: 'AddOrder', params: { ...ORDER, userref: 0 } }, { 'X-Proxy-Key': accessKey });
  assert.equal(zero.status, 400);
  const orders = [{ ordertype: 'limit', type: 'buy', volume: '0.01', price: '1000', userref: 5 }, { ordertype: 'limit', type: 'sell', volume: '0.01', price: '2000', userref: 5 }];
  const batch = await call(url, { method: 'AddOrderBatch', params: { pair: 'XBTUSD', orders } }, { 'X-Proxy-Key': accessKey });
  assert.equal(batch.status, 400);
  assert.equal(kraken.requests.length, 0);
});

test('validate: text values are handled, unclear ones refused', async (t) => {
  const { url, kraken, accessKey } = await setup(t, { env: { ENABLE_TRADING: 'true' } });
  const off = await call(url, { method: 'AddOrder', params: { ...ORDER, validate: 'false' } }, { 'X-Proxy-Key': accessKey });
  assert.equal(privateCalls(kraken, 'AddOrder')[0].params.validate, undefined);
  assert.equal(proxyOf(off).executed, 'yes');
  const odd = await call(url, { method: 'AddOrder', params: { ...ORDER, validate: 'maybe' } }, { 'X-Proxy-Key': accessKey });
  assert.equal(odd.status, 400);
  const batchOff = await call(url, { method: 'AddOrderBatch', params: { pair: 'XBTUSD', validate: 'false', orders: [{ ordertype: 'limit', type: 'buy', volume: '0.01', price: '1000' }, { ordertype: 'limit', type: 'buy', volume: '0.01', price: '900' }] } }, { 'X-Proxy-Key': accessKey });
  assert.equal(JSON.parse(privateCalls(kraken, 'AddOrderBatch')[0].body).validate, undefined);
  assert.equal(proxyOf(batchOff).executed, 'yes');
});

test('a validate-only order that gets no answer is "not executed" (nothing to look up)', async (t) => {
  const handlers = { AddOrder: (record) => record.destroy() };
  const { url, kraken, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const res = await call(url, { method: 'AddOrder', params: { ...ORDER, validate: true } }, { 'X-Proxy-Key': accessKey });
  assert.equal(proxyOf(res).executed, 'no');
  assert.equal(privateCalls(kraken, 'OpenOrders').length, 0);
});

test('cancel whose first answer was lost: the retry does not report "not cancelled"', async (t) => {
  let n = 0;
  const handlers = {
    CancelOrder: (record, json, fake) => {
      n += 1;
      const hit = [...fake.book].find(([txid]) => txid === record.params.txid);
      if (n === 1) {
        hit[1].status = 'canceled';
        return record.destroy(); // cancelled, answer lost
      }
      return json(200, { error: ['EOrder:Unknown order'] });
    },
  };
  const { url, kraken, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const txid = kraken.fake.place(ORDER);
  const res = await call(url, { method: 'CancelOrder', params: { txid } }, { 'X-Proxy-Key': accessKey });
  const p = proxyOf(res);
  assert.equal(n, 2, 'the cancel was repeated once');
  assert.equal(p.executed, 'yes');
  assert.match(p.summary, /intento anterior/);
});

test('CancelAll whose first answer was lost: "unknown", not "no"', async (t) => {
  let n = 0;
  const handlers = {
    CancelAll: (record, json) => {
      n += 1;
      if (n === 1) return record.destroy();
      return json(200, { error: [], result: { count: 0 } });
    },
  };
  const { url, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const res = await call(url, { method: 'CancelAll' }, { 'X-Proxy-Key': accessKey });
  const p = proxyOf(res);
  assert.equal(p.executed, 'unknown');
  assert.match(p.next, /OpenOrders/);
});

test('cancel "Unknown order" while the order is still open: repeat it', async (t) => {
  const handlers = { CancelOrder: (record, json) => json(200, { error: ['EOrder:Unknown order'] }) };
  const { url, kraken, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const txid = kraken.fake.place(ORDER);
  const p = proxyOf(await call(url, { method: 'CancelOrder', params: { txid } }, { 'X-Proxy-Key': accessKey }));
  assert.equal(p.order.status, 'open');
  assert.equal(p.retry.safeToRetry, 'after-wait');
  assert.match(p.next, /repite la misma cancelación/);
});

test('amend rejected: says the change was not applied, not that the order does not exist', async (t) => {
  const handlers = { AmendOrder: (record, json) => json(200, { error: ['EOrder:Tick size check failed'] }) };
  const { url, kraken, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const txid = kraken.fake.place(ORDER);
  const p = proxyOf(await call(url, { method: 'AmendOrder', params: { txid, limit_price: '1000.05' } }, { 'X-Proxy-Key': accessKey }));
  assert.equal(p.executed, 'no');
  assert.doesNotMatch(p.summary, /NO se creó/);
  assert.match(p.summary, /El cambio NO se aplicó/);
});

test('an order retry is never sent after Muse hung up', async (t) => {
  let n = 0;
  const handlers = { AddOrder: (record, json) => { n += 1; json(200, { error: ['EAPI:Rate limit exceeded'] }); } };
  const kraken = await startFakeKraken({ handlers });
  t.after(() => kraken.close());
  const config = loadKrakenConfig({ KRAKEN_API_KEY: API_KEY, KRAKEN_API_SECRET: SECRET, KRAKEN_BASE_URL: kraken.url, ENABLE_TRADING: 'true' });
  const client = createKrakenClient(config);
  let gone = false;
  setTimeout(() => { gone = true; }, 500); // hangs up during the 4 s wait
  const res = await client.privateCall('AddOrder', { ...ORDER, cl_ord_id: 'x1' }, { policy: 'create', isCancelled: () => gone });
  assert.equal(n, 1);
  assert.equal(res.callerGone, true);
});

test('an ambiguous order answers within the request deadline, even if Kraken never answers', async (t) => {
  const hang = () => {}; // never answers
  const handlers = { AddOrder: hang, OpenOrders: hang, ClosedOrders: hang };
  const kraken = await startFakeKraken({ handlers });
  t.after(async () => {
    kraken.requests.forEach((r) => r.destroy());
    await kraken.close();
  });
  const config = loadKrakenConfig({ KRAKEN_API_KEY: API_KEY, KRAKEN_API_SECRET: SECRET, KRAKEN_BASE_URL: kraken.url, ENABLE_TRADING: 'true' });
  const client = createKrakenClient(config, { timeoutMs: 400 });
  const { createExecutor } = require('../src/kraken/execute');
  const { normalizeParams } = require('../src/kraken/params');
  const executor = createExecutor({ client, verifyDelaysMs: [100, 100], totalMs: { read: 3000, cancel: 3000, create: 3000 }, lookupReserveMs: 1500 });
  const prepared = normalizeParams('AddOrder', ORDER);
  const started = Date.now();
  const out = await executor.run({ method: 'AddOrder', readOnly: false, params: prepared.params, changes: prepared.changes, ids: prepared.ids });
  assert.ok(Date.now() - started < 3500, `took ${Date.now() - started} ms`);
  assert.equal(out.proxy.executed, 'unknown');
  assert.equal(out.proxy.retry.safeToRetry, 'check-first');
});

test('malformed order maps from Kraken never lose the answer', async (t) => {
  const handlers = { QueryOrders: (record, json) => json(200, { error: [], result: { BAD: null } }) };
  const { url, accessKey } = await setup(t, { handlers, env: { ENABLE_TRADING: 'true' } });
  const res = await call(url, { method: 'AddOrder', params: ORDER }, { 'X-Proxy-Key': accessKey });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.result.txid.length, 1);
  assert.equal(body.proxy.executed, 'yes');
});
