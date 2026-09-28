'use strict';

const http = require('node:http');
const https = require('node:https');
const { version } = require('../../package.json');
const { sign, createNonceSource } = require('./sign');

const USER_AGENT = `ghl-proxy-kraken/${version}`;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE = 30;
const NONCE_RETRY_DELAY_MS = 300;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Body for a private call: form-urlencoded with the nonce first (Kraken's documented format)
 * when every value is flat; JSON when a value is an array or object (AddOrderBatch,
 * CancelOrderBatch), since form encoding has no documented form for those. Either way the
 * signature covers exactly these bytes.
 */
function encodeBody(params, nonce) {
  const nested = Object.values(params).some((v) => v !== null && typeof v === 'object');
  if (nested) {
    return { body: JSON.stringify({ nonce: Number(nonce), ...params }), contentType: 'application/json' };
  }
  const form = new URLSearchParams();
  form.append('nonce', nonce);
  for (const [key, value] of Object.entries(params)) form.append(key, String(value));
  return { body: form.toString(), contentType: 'application/x-www-form-urlencoded' };
}

/**
 * Talks to api.kraken.com. Private calls go out one at a time per process: the nonce is
 * taken right before sending, so within one instance they always reach Kraken in order.
 * Nothing here logs or returns keys, signatures or request bodies.
 */
function createKrakenClient(config, { now = () => Date.now() } = {}) {
  const base = config.baseUrl;
  const transport = base.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 8 });
  const nextNonce = createNonceSource(now);
  let queue = Promise.resolve();
  let queued = 0;

  function send(method, path, { headers = {}, body } = {}) {
    return new Promise((resolve) => {
      const started = process.hrtime.bigint();
      const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
      const req = transport.request(
        new URL(path, base),
        { method, agent, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers }, timeout: config.timeoutMs },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              res.destroy();
              resolve({ status: 0, error: 'too_large', ms: elapsed() });
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, text, json: parseJson(text), ms: elapsed() });
          });
          res.on('error', () => resolve({ status: 0, error: 'network', ms: elapsed() }));
        },
      );
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'KRAKEN_TIMEOUT' })));
      req.on('error', (err) => resolve({ status: 0, error: err.code === 'KRAKEN_TIMEOUT' ? 'timeout' : 'network', ms: elapsed() }));
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  async function signedCall(method, params, { retryInvalidNonce }) {
    const path = `/0/private/${method}`;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const nonce = nextNonce();
      const { body, contentType } = encodeBody(params, nonce);
      const headers = {
        'API-Key': config.apiKey,
        'API-Sign': sign({ secret: config.secret, uriPath: path, nonce, postData: body }),
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(body),
      };
      const res = await send('POST', path, { headers, body });
      // Another instance may have used a higher nonce a moment earlier; a fresh one fixes it.
      // Once only (repeated invalid nonces lead to a lockout) and never for trading calls.
      const invalidNonce = res.json && Array.isArray(res.json.error) && res.json.error.includes('EAPI:Invalid nonce');
      if (invalidNonce && retryInvalidNonce && attempts === 1) {
        await sleep(NONCE_RETRY_DELAY_MS);
        continue;
      }
      return { ...res, attempts };
    }
  }

  return {
    /** Signed call to /0/private/<method>. `method` must already be allowlisted. */
    privateCall(method, params = {}, { retryInvalidNonce = false } = {}) {
      if (queued >= MAX_QUEUE) return Promise.resolve({ status: 0, error: 'busy', ms: 0, attempts: 0 });
      queued += 1;
      const enqueuedAt = process.hrtime.bigint();
      const run = queue.then(async () => {
        const waitMs = Number(process.hrtime.bigint() - enqueuedAt) / 1e6;
        const res = await signedCall(method, params, { retryInvalidNonce });
        return { ...res, waitMs };
      });
      queue = run.then(
        () => {},
        () => {},
      );
      return run.finally(() => {
        queued -= 1;
      });
    },

    /** Unsigned GET to /0/public/<name> (diagnostics only). */
    publicCall(name) {
      return send('GET', `/0/public/${name}`);
    },
  };
}

module.exports = { createKrakenClient, encodeBody, USER_AGENT };
