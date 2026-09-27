'use strict';

const http = require('node:http');
const { createApp } = require('../src/create-app');
const { loadConfig } = require('../src/config');

const TOKEN = 'pit-test-ghl-token-0123456789abcdef';
const KEY = 'test-proxy-key-0123456789abcdef0123456789abcdef';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Fake GHL. Records every request (method, url, headers, raw body) it receives. */
async function startUpstream(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, headers: req.headers, rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) };
      requests.push(record);
      if (handler) return handler(req, res, record);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ contacts: [], meta: { total: 0 } }));
    });
  });
  const url = await listen(server);
  return { url, server, requests, close: () => close(server) };
}

/** The proxy under test, in-process, pointed at `upstreamUrl`. */
async function startProxy(upstreamUrl, env = {}, appOptions = {}) {
  const config = loadConfig({ GHL_TOKEN: TOKEN, PROXY_KEY: KEY, GHL_BASE_URL: upstreamUrl, ...env });
  const lines = [];
  const logger = {
    info: (fields) => lines.push({ level: 'info', ...fields }),
    warn: (fields) => lines.push({ level: 'warn', ...fields }),
    error: (fields) => lines.push({ level: 'error', ...fields }),
  };
  const app = createApp(config, logger, appOptions);
  const server = http.createServer(app);
  const url = await listen(server);
  app.locals.selfUrl = url;
  return {
    url,
    config,
    logs: lines,
    close: async () => {
      app.locals.limiter.stop();
      await close(server);
    },
  };
}

/** Raw HTTP client so tests see exactly what the proxy sent (no auto-decompression). */
function request(url, { method = 'GET', headers = {}, body, path } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      { hostname: target.hostname, port: target.port, method, path: path ?? `${target.pathname}${target.search}`, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: buffer, text: buffer.toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const authed = (headers = {}) => ({ 'X-Proxy-Key': KEY, ...headers });

/** Waits until the access log has an entry for `path` (logs are written on response close). */
async function waitForLog(logs, predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = logs.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('log line not found');
}

module.exports = { TOKEN, KEY, startUpstream, startProxy, request, authed, waitForLog, listen, close };
