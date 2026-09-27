'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { TOKEN, KEY, startUpstream, request } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'src', 'server.js');

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function run(env) {
  const child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, exited, output: () => output };
}

async function waitFor(check, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

test('refuses to start without GHL_TOKEN or PROXY_KEY', async () => {
  for (const env of [{}, { GHL_TOKEN: TOKEN }, { PROXY_KEY: KEY }]) {
    const proc = run(env);
    assert.equal(await proc.exited, 1);
    assert.match(proc.output(), /startup_failed/);
  }
});

test('starts, serves traffic, never logs secrets, exits cleanly on SIGTERM', async (t) => {
  const upstream = await startUpstream();
  t.after(() => upstream.close());
  const port = await freePort();
  const proc = run({ GHL_TOKEN: TOKEN, PROXY_KEY: KEY, PORT: String(port), GHL_BASE_URL: upstream.url });
  t.after(() => proc.child.kill('SIGKILL'));

  await waitFor(() => proc.output().includes('"listening"'));
  const base = `http://127.0.0.1:${port}`;
  assert.deepEqual(JSON.parse((await request(`${base}/health`)).text), { ok: true, version: '1.0.0' });
  assert.equal((await request(`${base}/ghl/contacts/?limit=1`)).status, 401);
  assert.equal((await request(`${base}/ghl/contacts/?limit=1`, { headers: { 'X-Proxy-Key': KEY } })).status, 200);

  proc.child.kill('SIGTERM');
  assert.equal(await proc.exited, 0);
  const out = proc.output();
  assert.ok(!out.includes(TOKEN), 'GHL token leaked to logs');
  assert.ok(!out.includes(KEY), 'proxy key leaked to logs');
  for (const line of out.trim().split('\n')) JSON.parse(line); // every line is JSON
});

test('SIGTERM lets in-flight requests finish, closes keep-alive connections and exits promptly', async (t) => {
  const upstream = await startUpstream((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"slow":true}');
    }, 500);
  });
  t.after(() => upstream.close());
  const port = await freePort();
  const proc = run({ GHL_TOKEN: TOKEN, PROXY_KEY: KEY, PORT: String(port), GHL_BASE_URL: upstream.url });
  t.after(() => proc.child.kill('SIGKILL'));
  await waitFor(() => proc.output().includes('"listening"'));

  const agent = new http.Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const inFlight = new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/ghl/slow', agent, headers: { 'X-Proxy-Key': KEY } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
  });
  await waitFor(() => upstream.requests.length === 1);
  const signalledAt = Date.now();
  proc.child.kill('SIGTERM');

  const res = await inFlight;
  assert.equal(res.statusCode, 200);
  assert.equal(await proc.exited, 0);
  assert.ok(Date.now() - signalledAt < 3000, `exit took ${Date.now() - signalledAt} ms`);
});
