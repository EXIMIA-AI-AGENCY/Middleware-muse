'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { TOKEN, KEY, startUpstream, startProxy, request, authed } = require('./helpers');

const SESSION = 'mcp-session-7f3a';

/** Minimal GHL-like MCP server (streamable HTTP): SSE for initialize, JSON otherwise. */
function fakeMcp(req, res, record) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    return res.end();
  }
  const msg = JSON.parse(record.body.toString('utf8'));
  if (msg.method === 'initialize') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Mcp-Session-Id': SESSION });
    const payload = {
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ghl-mcp', version: '1' } },
    };
    return res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  }
  if (req.headers['mcp-session-id'] !== SESSION) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'missing session' } }));
  }
  if (msg.method === 'notifications/initialized') {
    res.writeHead(202);
    return res.end();
  }
  if (msg.method === 'tools/list') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'contacts_get-contacts', inputSchema: { type: 'object' } }] } }));
  }
  if (msg.method === 'tools/call') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: '{"contacts":[]}' }] } }));
  }
  res.writeHead(404);
  return res.end();
}

async function setup(t, handler = fakeMcp) {
  const upstream = await startUpstream(handler);
  const proxy = await startProxy(upstream.url);
  t.after(async () => {
    await proxy.close();
    await upstream.close();
  });
  return { upstream, proxy };
}

const rpc = (proxy, body, headers = {}, path = '/mcp/') =>
  request(`${proxy.url}${path}`, {
    method: 'POST',
    headers: authed({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }),
    body: JSON.stringify(body),
  });

function parseSse(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5).trim()));
}

test('MCP handshake: initialize -> notifications/initialized -> tools/list -> tools/call', async (t) => {
  const { proxy, upstream } = await setup(t);

  const init = await rpc(proxy, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'muse', version: '1' } },
  });
  assert.equal(init.status, 200);
  assert.match(init.headers['content-type'], /text\/event-stream/);
  assert.equal(init.headers['mcp-session-id'], SESSION);
  const [initResult] = parseSse(init.text);
  assert.equal(initResult.jsonrpc, '2.0');
  assert.equal(initResult.id, 1);
  assert.equal(initResult.result.protocolVersion, '2025-06-18');

  const session = { 'Mcp-Session-Id': SESSION, 'MCP-Protocol-Version': '2025-06-18' };
  const notified = await rpc(proxy, { jsonrpc: '2.0', method: 'notifications/initialized' }, session);
  assert.equal(notified.status, 202);

  const list = await rpc(proxy, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, session);
  assert.equal(list.status, 200);
  assert.equal(JSON.parse(list.text).result.tools[0].name, 'contacts_get-contacts');

  const call = await rpc(proxy, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'contacts_get-contacts', arguments: {} } }, session);
  assert.equal(JSON.parse(call.text).result.content[0].type, 'text');

  assert.equal(upstream.requests.length, 4);
  for (const seen of upstream.requests) {
    assert.equal(seen.url, '/mcp/');
    assert.equal(seen.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(seen.headers.locationid, 'L3bLLVwvhdJ7A9WqkPxM');
    assert.equal(seen.headers.version, '2021-07-28');
    assert.match(seen.headers['user-agent'], /^Mozilla\/5\.0/);
    assert.equal(seen.headers['x-proxy-key'], undefined);
  }
  assert.equal(upstream.requests[1].headers['mcp-session-id'], SESSION);
  assert.equal(upstream.requests[1].headers['mcp-protocol-version'], '2025-06-18');
});

test('/mcp and /mcp/ both reach upstream /mcp/', async (t) => {
  const { proxy, upstream } = await setup(t);
  const body = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } } };
  assert.equal((await rpc(proxy, body, {}, '/mcp')).status, 200);
  assert.equal((await rpc(proxy, body, {}, '/mcp/?trace=1')).status, 200);
  assert.deepEqual(upstream.requests.map((r) => r.url), ['/mcp/', '/mcp/?trace=1']);
});

test('MCP header normalisation for bare clients (e.g. Python urllib)', async (t) => {
  const { proxy, upstream } = await setup(t);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
  await request(`${proxy.url}/mcp/`, {
    method: 'POST',
    headers: { 'X-Proxy-Key': KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Python-urllib/3.11' },
    body,
  });
  const seen = upstream.requests[0];
  assert.equal(seen.headers['content-type'], 'application/json');
  assert.equal(seen.headers.accept, 'application/json, text/event-stream');
  assert.equal(seen.body.toString(), body);

  // A client that already sends the right values keeps them, including its own locationId.
  await rpc(proxy, JSON.parse(body), { Accept: 'text/event-stream, application/json', locationId: 'OtherLocation' });
  assert.equal(upstream.requests[1].headers.accept, 'text/event-stream, application/json');
  assert.equal(upstream.requests[1].headers.locationid, 'OtherLocation');
});

test('MCP GET/DELETE are relayed so upstream decides', async (t) => {
  const { proxy, upstream } = await setup(t);
  const res = await request(`${proxy.url}/mcp/`, { headers: authed({ Accept: 'text/event-stream' }) });
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, 'POST');
  assert.equal(upstream.requests[0].method, 'GET');
});

test('SSE responses are streamed event by event, not buffered', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { proxy } = await setup(t, async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":1}}\n\n');
    await gate; // hold the rest until the client proves it already got the first event
    res.end('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n');
  });

  const events = [];
  await new Promise((resolve, reject) => {
    const target = new URL(`${proxy.url}/mcp/`);
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: authed({ 'Content-Type': 'application/json' }) },
      (res) => {
        assert.equal(res.headers['x-accel-buffering'], 'no');
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          events.push(chunk);
          if (events.length === 1) release();
        });
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.end('{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"x","arguments":{}}}');
    setTimeout(() => reject(new Error('stream stalled: first event was buffered')), 3000).unref();
  });
  const all = parseSse(events.join(''));
  assert.equal(all.length, 2);
  assert.equal(all[1].id, 7);
});
