'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const zlib = require('node:zlib');
const { TOKEN, KEY, startUpstream, startProxy, request, authed, waitForLog, listen, close } = require('./helpers');

const LOCATION = 'L3bLLVwvhdJ7A9WqkPxM';

async function setup(t, handler, env) {
  const upstream = await startUpstream(handler);
  const proxy = await startProxy(upstream.url, env);
  t.after(async () => {
    await proxy.close();
    await upstream.close();
  });
  return { upstream, proxy };
}

test('GET /health answers without a key', async (t) => {
  const { proxy, upstream } = await setup(t);
  const res = await request(`${proxy.url}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { ok: true, version: '1.0.0' });
  assert.match(res.headers['content-type'], /application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-powered-by'], undefined);
  assert.equal(upstream.requests.length, 0);
});

test('missing, wrong or misplaced key -> 401 and nothing reaches GHL', async (t) => {
  const { proxy, upstream } = await setup(t);
  const url = `${proxy.url}/ghl/contacts/?locationId=${LOCATION}&limit=1`;
  const attempts = [
    {},
    { 'X-Proxy-Key': '' },
    { 'X-Proxy-Key': 'wrong' },
    { 'X-Proxy-Key': `${KEY}x` },
    { 'X-Proxy-Key': KEY.slice(0, -1) },
    { Authorization: `Bearer ${KEY}` }, // only header:X-Proxy-Key is accepted
    { 'X-Proxy-Key': TOKEN }, // the GHL token is not a proxy key
  ];
  for (const headers of attempts) {
    const res = await request(url, { headers });
    assert.equal(res.status, 401, JSON.stringify(headers));
    assert.deepEqual(JSON.parse(res.text), { error: 'unauthorized' });
  }
  for (const path of ['/mcp/', '/mcp', '/', '/unknown', '/ghl', '/health/../ghl/contacts/']) {
    const res = await request(proxy.url, { path, method: 'POST', body: '{}' });
    assert.equal(res.status, 401, path);
  }
  assert.equal(upstream.requests.length, 0);
});

test('/ghl/* strips the prefix and keeps path and raw query string intact', async (t) => {
  const { proxy, upstream } = await setup(t);
  const query = `locationId=${LOCATION}&limit=1&query=a%20b%2Bc&tags[]=x&email=a%40b.co`;
  const res = await request(`${proxy.url}/ghl/contacts/?${query}`, { headers: authed() });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { contacts: [], meta: { total: 0 } });
  assert.equal(upstream.requests.length, 1);
  assert.equal(upstream.requests[0].method, 'GET');
  assert.equal(upstream.requests[0].url, `/contacts/?${query}`);

  await request(`${proxy.url}/ghl/locations/${LOCATION}/customFields`, { headers: authed() });
  assert.equal(upstream.requests[1].url, `/locations/${LOCATION}/customFields`);
  await request(`${proxy.url}/ghl`, { headers: authed() });
  assert.equal(upstream.requests[2].url, '/');
  await request(`${proxy.url}/ghl?x=1`, { headers: authed() });
  assert.equal(upstream.requests[3].url, '/?x=1');
  await request(`${proxy.url}/ghl//contacts/`, { headers: authed() });
  assert.equal(upstream.requests[4].url, '//contacts/');
});

test('injects GHL credentials and headers; never forwards the proxy key', async (t) => {
  const { proxy, upstream } = await setup(t);
  await request(`${proxy.url}/ghl/contacts/?locationId=${LOCATION}&limit=1`, {
    headers: authed({
      Authorization: 'Bearer client-supplied',
      'User-Agent': 'Python-urllib/3.11',
      'X-Custom-Header': 'kept',
      Cookie: 'a=b',
    }),
  });
  const { headers } = upstream.requests[0];
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers.version, '2021-07-28');
  assert.equal(headers.accept, 'application/json');
  assert.match(headers['user-agent'], /^Mozilla\/5\.0 .*Chrome\/\d+/);
  assert.doesNotMatch(headers['user-agent'], /python|urllib|node/i);
  assert.equal(headers.host, new URL(upstream.url).host);
  assert.equal(headers['x-custom-header'], 'kept');
  assert.equal(headers.cookie, 'a=b');
  assert.equal(headers['x-proxy-key'], undefined);
  assert.ok(!JSON.stringify(upstream.requests[0].rawHeaders).includes(KEY));
});

test('client may override Version and Accept; `*/*` becomes application/json', async (t) => {
  const { proxy, upstream } = await setup(t);
  await request(`${proxy.url}/ghl/conversations/search`, { headers: authed({ Version: '2021-04-15', Accept: 'text/csv' }) });
  assert.equal(upstream.requests[0].headers.version, '2021-04-15');
  assert.equal(upstream.requests[0].headers.accept, 'text/csv');
  await request(`${proxy.url}/ghl/contacts/`, { headers: authed({ Accept: '*/*' }) });
  assert.equal(upstream.requests[1].headers.accept, 'application/json');
});

test('strips hop-by-hop and hosting-platform headers', async (t) => {
  const { proxy, upstream } = await setup(t);
  await request(`${proxy.url}/ghl/contacts/`, {
    headers: authed({
      Connection: 'keep-alive, X-Secret-Hop',
      'X-Secret-Hop': 'drop-me',
      'Keep-Alive': 'timeout=5',
      'Proxy-Authorization': 'Basic abc',
      'X-Forwarded-For': '203.0.113.9',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'ghl-proxy.example.com',
      Forwarded: 'for=203.0.113.9',
      Via: '1.1 edge',
      'X-Real-IP': '203.0.113.9',
      'CF-Connecting-IP': '203.0.113.9',
      'CF-Ray': 'abc',
      'CDN-Loop': 'cloudflare',
      'Fly-Client-IP': '203.0.113.9',
      'X-Railway-Request-Id': 'r1',
      'Rndr-Id': 'r2',
      'X-Vercel-Id': 'iad1::abc',
      'X-Vercel-Oidc-Token': 'vercel-credential',
      'X-Vercel-Forwarded-For': '203.0.113.9',
      'X-Matched-Path': '/index',
    }),
  });
  const names = Object.keys(upstream.requests[0].headers);
  for (const dropped of [
    'x-secret-hop',
    'keep-alive',
    'proxy-authorization',
    'x-forwarded-for',
    'x-forwarded-proto',
    'x-forwarded-host',
    'forwarded',
    'via',
    'x-real-ip',
    'cf-connecting-ip',
    'cf-ray',
    'cdn-loop',
    'fly-client-ip',
    'x-railway-request-id',
    'rndr-id',
    'x-vercel-id',
    'x-vercel-oidc-token',
    'x-vercel-forwarded-for',
    'x-matched-path',
  ]) {
    assert.ok(!names.includes(dropped), `${dropped} should not be forwarded`);
  }
});

test('forwards method and body byte-for-byte', async (t) => {
  const { proxy, upstream } = await setup(t, (req, res, record) => {
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ echoed: record.body.toString('utf8') }));
  });
  const payload = JSON.stringify({ firstName: 'Ana', email: 'ana@example.com', locationId: LOCATION, note: 'ñ✓' });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await request(`${proxy.url}/ghl/contacts/abc`, {
      method,
      headers: authed({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
      body: payload,
    });
    assert.equal(res.status, 201, method);
    const seen = upstream.requests.at(-1);
    assert.equal(seen.method, method);
    assert.equal(seen.url, '/contacts/abc');
    assert.equal(seen.body.toString('utf8'), payload);
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.equal(seen.headers['content-length'], String(Buffer.byteLength(payload)));
  }
});

test('forwards chunked request bodies (no Content-Length)', async (t) => {
  const { proxy, upstream } = await setup(t);
  await new Promise((resolve, reject) => {
    const target = new URL(`${proxy.url}/ghl/contacts/upsert`);
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: authed({ 'Content-Type': 'application/json' }) },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.write('{"a":');
    setTimeout(() => req.end('1}'), 20);
  });
  const seen = upstream.requests[0];
  assert.equal(seen.body.toString(), '{"a":1}');
  assert.equal(seen.headers['transfer-encoding'], 'chunked');
});

test('returns upstream status, headers and body unmodified', async (t) => {
  const body = JSON.stringify({ statusCode: 422, message: ['email must be an email'] });
  const { proxy } = await setup(t, (req, res) => {
    res.writeHead(422, 'Unprocessable Entity', [
      'Content-Type', 'application/json; charset=utf-8',
      'Content-Length', String(Buffer.byteLength(body)),
      'X-RateLimit-Remaining', '99',
      'Set-Cookie', '__cf_bm=one; Path=/',
      'Set-Cookie', 'other=two; Path=/',
      'ETag', 'W/"abc"',
    ]);
    res.end(body);
  });
  const res = await request(`${proxy.url}/ghl/contacts/`, { headers: authed() });
  assert.equal(res.status, 422);
  assert.equal(res.text, body);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['content-length'], String(Buffer.byteLength(body)));
  assert.equal(res.headers['x-ratelimit-remaining'], '99');
  assert.equal(res.headers.etag, 'W/"abc"');
  assert.deepEqual(res.headers['set-cookie'], ['__cf_bm=one; Path=/', 'other=two; Path=/']);
});

test('compressed upstream bodies pass through untouched', async (t) => {
  const original = JSON.stringify({ contacts: Array.from({ length: 50 }, (_, i) => ({ id: `c${i}` })) });
  const gz = zlib.gzipSync(original);
  const { proxy, upstream } = await setup(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
    res.end(gz);
  });
  const res = await request(`${proxy.url}/ghl/contacts/`, { headers: authed({ 'Accept-Encoding': 'gzip' }) });
  assert.equal(upstream.requests[0].headers['accept-encoding'], 'gzip');
  assert.equal(res.headers['content-encoding'], 'gzip');
  assert.ok(res.body.equals(gz));
  assert.equal(zlib.gunzipSync(res.body).toString(), original);
});

test('HEAD and 204 responses', async (t) => {
  const { proxy } = await setup(t, (req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '42' });
      return res.end();
    }
    res.writeHead(204);
    return res.end();
  });
  const head = await request(`${proxy.url}/ghl/contacts/`, { method: 'HEAD', headers: authed() });
  assert.equal(head.status, 200);
  assert.equal(head.headers['content-length'], '42');
  assert.equal(head.body.length, 0);
  const del = await request(`${proxy.url}/ghl/contacts/x`, { method: 'DELETE', headers: authed() });
  assert.equal(del.status, 204);
  assert.equal(del.body.length, 0);
});

test('unknown routes need the key and return 404', async (t) => {
  const { proxy, upstream } = await setup(t);
  assert.equal((await request(`${proxy.url}/contacts/`)).status, 401);
  const res = await request(`${proxy.url}/contacts/`, { headers: authed() });
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.text), { error: 'not_found' });
  assert.equal((await request(`${proxy.url}/ghlx/contacts`, { headers: authed() })).status, 404);
  assert.equal(upstream.requests.length, 0);
});

test('absolute-form request targets are rejected', async (t) => {
  const { proxy, upstream } = await setup(t);
  const res = await request(proxy.url, { path: 'http://evil.example/ghl/contacts/', headers: authed() });
  assert.ok([400, 404].includes(res.status), String(res.status));
  assert.equal(upstream.requests.length, 0);
});

test('TRACE is refused so the injected token can never be echoed back', async (t) => {
  const { proxy, upstream } = await setup(t);
  for (const path of ['/ghl/contacts/', '/mcp/']) {
    const res = await request(`${proxy.url}${path}`, { method: 'TRACE', headers: authed() });
    assert.equal(res.status, 405, path);
    assert.deepEqual(JSON.parse(res.text), { error: 'method_not_allowed' });
    assert.match(res.headers.allow, /POST/);
  }
  assert.equal(upstream.requests.length, 0);
});

/** Upstream that answers every connection with raw bytes (to emulate broken peers). */
async function rawUpstream(t, reply) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('data', () => socket.end(reply));
    socket.on('error', () => {});
  });
  const url = await listen(server);
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return url;
}

test('malformed upstream status lines fail the request, not the process', async (t) => {
  const cases = [
    { raw: 'HTTP/1.1 200 O\x01K\r\nContent-Length: 2\r\n\r\nok', status: 200, body: 'ok' },
    { raw: 'HTTP/1.1 201 \x7f\r\nContent-Length: 0\r\n\r\n', status: 201, body: '' },
    { raw: 'HTTP/1.1 099 Weird\r\nContent-Length: 0\r\n\r\n', status: 502 },
    { raw: 'HTTP/1.1 000 Zero\r\nContent-Length: 0\r\n\r\n', status: 502 },
    { raw: 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n', status: 502 },
  ];
  for (const c of cases) {
    const url = await rawUpstream(t, c.raw);
    const proxy = await startProxy(url, { UPSTREAM_TIMEOUT_MS: '5000' });
    t.after(() => proxy.close());
    const started = Date.now();
    const res = await request(`${proxy.url}/ghl/x`, { headers: authed() });
    assert.equal(res.status, c.status, JSON.stringify(c.raw));
    if (c.body !== undefined) assert.equal(res.text, c.body);
    if (c.status === 502) assert.deepEqual(JSON.parse(res.text), { error: 'bad_gateway' });
    assert.ok(Date.now() - started < 2000, 'answered promptly');
    // Still serving afterwards.
    assert.equal((await request(`${proxy.url}/health`)).status, 200);
  }
});

test('early upstream answer during a large upload: client gets it and the upload is drained', async (t) => {
  const upstream = http.createServer((req, res) => {
    // Answer without waiting for the body, as GHL does for 401/413 on uploads.
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end('{"statusCode":401,"message":"Invalid Private Integration token"}');
  });
  const upstreamUrl = await listen(upstream);
  t.after(() => close(upstream));
  const proxy = await startProxy(upstreamUrl);
  t.after(() => proxy.close());

  const body = Buffer.alloc(20 * 1024 * 1024, 'a');
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const started = Date.now();
  const outcome = await new Promise((resolve, reject) => {
    let status;
    let sent = false;
    let received = false;
    const done = () => sent && received && resolve({ status, ms: Date.now() - started });
    const target = new URL(`${proxy.url}/ghl/medias/upload-file`);
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', agent, headers: authed({ 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }) },
      (res) => {
        status = res.statusCode;
        res.resume();
        res.on('end', () => {
          received = true;
          done();
        });
      },
    );
    // 'finish' only fires once the proxy has read the whole body; a stalled proxy never gets here.
    req.on('finish', () => {
      sent = true;
      done();
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(outcome.status, 401);
  assert.ok(outcome.ms < 4000, `took ${outcome.ms} ms`);
});

test('rate limit: 429 with Retry-After once the per-key budget is spent', async (t) => {
  const { proxy, upstream } = await setup(t, undefined, { RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '400' });
  for (let i = 0; i < 3; i++) {
    assert.equal((await request(`${proxy.url}/ghl/contacts/`, { headers: authed() })).status, 200);
  }
  const limited = await request(`${proxy.url}/ghl/contacts/`, { headers: authed() });
  assert.equal(limited.status, 429);
  assert.deepEqual(JSON.parse(limited.text), { error: 'rate_limited' });
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal(upstream.requests.length, 3);

  // Health and unauthenticated calls do not consume the key's budget.
  assert.equal((await request(`${proxy.url}/health`)).status, 200);
  assert.equal((await request(`${proxy.url}/ghl/contacts/`)).status, 401);

  await new Promise((r) => setTimeout(r, 450));
  assert.equal((await request(`${proxy.url}/ghl/contacts/`, { headers: authed() })).status, 200);
});

test('upstream unreachable -> 502 JSON', async (t) => {
  const dead = http.createServer();
  const deadUrl = await listen(dead);
  await close(dead);
  const proxy = await startProxy(deadUrl);
  t.after(() => proxy.close());
  const res = await request(`${proxy.url}/ghl/contacts/`, { headers: authed() });
  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(res.text), { error: 'bad_gateway' });
  const line = await waitForLog(proxy.logs, (l) => l.msg === 'upstream_error');
  assert.equal(line.code, 'ECONNREFUSED');
});

test('upstream too slow -> 504 JSON', async (t) => {
  const { proxy } = await setup(t, () => {}, { UPSTREAM_TIMEOUT_MS: '150' });
  const res = await request(`${proxy.url}/ghl/contacts/`, { headers: authed() });
  assert.equal(res.status, 504);
  assert.deepEqual(JSON.parse(res.text), { error: 'upstream_timeout' });
});

test('client disconnect aborts the upstream request', async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const { proxy } = await setup(t, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: message\ndata: {}\n\n');
    res.on('close', upstreamClosed);
  });
  await new Promise((resolve, reject) => {
    const target = new URL(`${proxy.url}/ghl/stream`);
    const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname, headers: authed() }, (res) => {
      res.once('data', () => {
        req.destroy();
        resolve();
      });
    });
    req.on('error', () => {});
    req.on('close', resolve);
    req.end();
    setTimeout(() => reject(new Error('no data')), 2000).unref();
  });
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream not closed')), 2000))]);
});

test('retries once when a pooled keep-alive socket was closed by GHL', async (t) => {
  let n = 0;
  const { proxy, upstream } = await setup(t, (req, res) => {
    n += 1;
    if (n === 2) {
      // Simulate the peer dropping an idle keep-alive connection right as it is reused.
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'keep-alive' });
    res.end('{"ok":1}');
  });
  assert.equal((await request(`${proxy.url}/ghl/a`, { headers: authed() })).status, 200);
  const second = await request(`${proxy.url}/ghl/b`, { headers: authed() });
  assert.equal(second.status, 200);
  assert.equal(upstream.requests.filter((r) => r.url === '/b').length, 2);
});

test('access log: method, path, status, latency only — no query, headers, bodies or secrets', async (t) => {
  const { proxy } = await setup(t);
  await request(`${proxy.url}/ghl/contacts/?locationId=${LOCATION}&query=ana%40example.com`, { headers: authed() });
  await request(`${proxy.url}/ghl/contacts/`, { headers: { 'X-Proxy-Key': 'wrong-key' } });
  await request(`${proxy.url}/ghl/contacts/`, { method: 'POST', headers: authed({ 'Content-Type': 'application/json' }), body: '{"email":"ana@example.com"}' });
  await waitForLog(proxy.logs, (l) => l.method === 'POST');

  const access = proxy.logs.filter((l) => l.method);
  assert.equal(access.length, 3);
  for (const line of access) {
    assert.deepEqual(Object.keys(line).sort(), ['level', 'method', 'ms', 'path', 'status']);
    assert.equal(line.path, '/ghl/contacts/');
    assert.equal(typeof line.ms, 'number');
  }
  assert.deepEqual(access.map((l) => l.status), [200, 401, 200]);
  const all = JSON.stringify(proxy.logs);
  for (const secret of [TOKEN, KEY, 'wrong-key', 'ana@example.com', 'ana%40example.com', LOCATION]) {
    assert.ok(!all.includes(secret), `log leaked ${secret}`);
  }
});
