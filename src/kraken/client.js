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
function createKrakenClient(config, { now = () => Date.now(), timeoutMs = config.timeoutMs } = {}) {
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
      let deadline = null;
      const finish = (result) => {
        clearTimeout(deadline);
        resolve(result);
      };
      const req = transport.request(
        new URL(path, base),
        { method, agent, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers } },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              res.destroy();
              finish({ status: 0, error: 'too_large', ms: elapsed() });
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            finish({ status: res.statusCode, text, json: parseJson(text), ms: elapsed() });
          });
          res.on('error', () => finish({ status: 0, error: 'network', ms: elapsed() }));
          res.on('aborted', () => finish({ status: 0, error: 'network', ms: elapsed() }));
        },
      );
      // One deadline for the whole exchange: a slow trickle of bytes cannot hold the queue.
      deadline = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'KRAKEN_TIMEOUT' })), timeoutMs);
      req.on('error', (err) => {
        const timedOut = err.code === 'KRAKEN_TIMEOUT';
        // `reused` + no response: a kept-alive socket that had gone stale, so Kraken never saw it.
        finish({ status: 0, error: timedOut ? 'timeout' : 'network', reused: Boolean(req.reusedSocket) && !timedOut, ms: elapsed() });
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  async function signedCall(method, params, { readOnly }) {
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
      // Reads only, once: another instance may have used a higher nonce a moment earlier (a
      // fresh one fixes it; repeated invalid nonces lead to a lockout), or a kept-alive socket
      // had gone stale before the request left. Trading calls are never repeated.
      if (readOnly && attempts === 1) {
        const invalidNonce = res.json && Array.isArray(res.json.error) && res.json.error.includes('EAPI:Invalid nonce');
        if (invalidNonce) {
          await sleep(NONCE_RETRY_DELAY_MS);
          continue;
        }
        if (res.status === 0 && res.reused) continue;
      }
      return { ...res, attempts };
    }
  }

  return {
    /**
     * Signed call to /0/private/<method>. `method` must already be allowlisted. `readOnly`
     * allows one safe retry; `isCancelled()` is checked right before signing, so a call whose
     * caller has already hung up never reaches Kraken.
     */
    privateCall(method, params = {}, { readOnly = false, isCancelled = () => false } = {}) {
      if (queued >= MAX_QUEUE) return Promise.resolve({ status: 0, error: 'busy', ms: 0, attempts: 0 });
      queued += 1;
      const enqueuedAt = process.hrtime.bigint();
      const run = queue.then(async () => {
        const waitMs = Number(process.hrtime.bigint() - enqueuedAt) / 1e6;
        if (isCancelled()) return { status: 0, error: 'cancelled', ms: 0, attempts: 0, waitMs };
        const res = await signedCall(method, params, { readOnly });
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
