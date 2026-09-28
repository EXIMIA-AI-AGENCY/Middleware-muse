'use strict';

const http = require('node:http');
const https = require('node:https');
const { version } = require('../../package.json');

// Stripe's current API version (docs.stripe.com/api/versioning, 2026-09). Sent when Muse does
// not send one, so answers keep the shape Muse was told about; /v2 requires it.
const DEFAULT_API_VERSION = '2026-08-26.dahlia';
const USER_AGENT = `ghl-proxy-stripe/${version}`;
// Headers Muse may send that Stripe understands; everything else stays here.
const FORWARD = ['content-type', 'accept', 'accept-language', 'stripe-version', 'stripe-account', 'stripe-context', 'idempotency-key'];
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'set-cookie']);
// Errors that prove the request never reached Stripe.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']);

const AGENTS = {
  'https:': new https.Agent({ keepAlive: true, maxSockets: 64, timeout: 30_000 }),
  'http:': new http.Agent({ keepAlive: true, maxSockets: 64, timeout: 30_000 }),
};
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a finished attempt may be repeated, following Stripe's rules
 * (docs.stripe.com/error-low-level, stripe-node): Stripe-Should-Retry decides when present;
 * otherwise 409 (idempotency conflict), a 429 without Stripe-Rate-Limited-Reason (lock
 * timeout) and 5xx are retried. Real rate limits (429 with a reason) go back to Muse.
 * Only called for requests that are safe to repeat (GET, DELETE, POST with an idempotency key).
 */
function retryableResponse(status, headers) {
  const hint = headers['stripe-should-retry'];
  if (hint === 'true') return true;
  if (hint === 'false') return false;
  if (status === 409) return true;
  if (status === 429) return !headers['stripe-rate-limited-reason'];
  return status >= 500;
}

/** Stripe's backoff: 0.5 s doubling, at most 5 s, with 50–100 % jitter. */
function backoffMs(retry, random = Math.random) {
  const base = Math.min(5000, 500 * 2 ** (retry - 1));
  return Math.max(500, Math.round(base * (0.5 + random() * 0.5)));
}

/**
 * Sends one Stripe request, retrying only when repeating it cannot do anything twice:
 * reads and deletes are idempotent, and every write carries an Idempotency-Key, so Stripe
 * answers a repeat with the first result instead of acting again.
 *
 * Resolves to { res, attempts } with the final response still unread (the caller streams
 * it), or to { error, sent, attempts } when no answer came back at all.
 */
function createStripeClient(config, { sleep = defaultSleep, now = () => Date.now(), totalMs = 25_000, maxRetries = 2, random = Math.random } = {}) {
  const base = config.baseUrl;
  const transport = base.protocol === 'https:' ? https : http;
  const agent = AGENTS[base.protocol];

  function headersFor(incoming, body) {
    const headers = {};
    for (const name of FORWARD) if (incoming[name] !== undefined) headers[name] = incoming[name];
    headers.authorization = `Bearer ${config.secretKey}`;
    headers['user-agent'] = USER_AGENT;
    if (!headers['stripe-version']) headers['stripe-version'] = config.apiVersion || DEFAULT_API_VERSION;
    if (body && body.length) headers['content-length'] = String(body.length);
    return headers;
  }

  function attempt({ method, url, headers, body, timeoutMs, timing }) {
    return new Promise((resolve) => {
      let settled = false;
      let written = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const req = transport.request({
        protocol: base.protocol,
        hostname: base.hostname.replace(/^\[|\]$/g, ''),
        port: base.port || undefined,
        method,
        path: url,
        headers,
        agent,
      });
      const timer = setTimeout(() => {
        req.destroy(Object.assign(new Error('timeout'), { code: 'UPSTREAM_TIMEOUT' }));
      }, Math.max(1, timeoutMs));
      req.once('socket', () => timing && timing.sent());
      req.once('finish', () => {
        written = true;
      });
      req.on('response', (res) => {
        if (timing) timing.upstreamHeaders();
        done({ res });
      });
      req.on('error', (err) => {
        const code = (err && err.code) || 'ERROR';
        // A stale keep-alive socket or a refused connection means Stripe got nothing.
        const sent = written && !(req.reusedSocket && code === 'ECONNRESET') && !NOT_SENT.has(code);
        done({ error: code, sent });
      });
      if (body && body.length) req.end(body);
      else req.end();
    });
  }

  /**
   * @param {object} request  method, url (path + query), headers (Muse's), body (Buffer),
   *                          repeatable (safe to send again), timing (metrics)
   */
  async function call({ method, url, headers: incoming, body, repeatable, timing }) {
    const deadline = now() + totalMs;
    const headers = headersFor(incoming, body);
    let attempts = 0;
    let everSent = false;
    for (let retry = 0; ; retry += 1) {
      attempts += 1;
      const outcome = await attempt({ method, url, headers, body, timeoutMs: deadline - now(), timing });
      if (outcome.error) everSent = everSent || outcome.sent;
      const canRepeat = outcome.error ? repeatable || !outcome.sent : repeatable && retryableResponse(outcome.res.statusCode, outcome.res.headers);
      const wait = backoffMs(retry + 1, random);
      const timeLeft = deadline - now() - wait;
      if (!canRepeat || retry >= maxRetries || timeLeft < 2000) {
        if (outcome.error) return { error: outcome.error, sent: everSent, attempts };
        return { res: outcome.res, attempts };
      }
      if (outcome.res) outcome.res.resume(); // discard the body of an attempt we repeat
      await sleep(wait);
    }
  }

  /** A read for the panel (never retried, short timeout). Resolves { status, headers, text, ms } or { status: 0, error }. */
  function get(path, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const started = Date.now();
      const req = transport.request(
        { protocol: base.protocol, hostname: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || undefined, method: 'GET', path, headers: headersFor({}, null), agent },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size <= 1024 * 1024) chunks.push(c);
          });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started }));
          res.on('error', () => resolve({ status: 0, error: 'RESPONSE_ERROR', ms: Date.now() - started }));
        },
      );
      const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), timeoutMs);
      req.on('error', (err) => resolve({ status: 0, error: (err && err.code) || 'ERROR', ms: Date.now() - started }));
      req.on('close', () => clearTimeout(timer));
      req.end();
    });
  }

  return { call, get };
}

module.exports = { createStripeClient, retryableResponse, backoffMs, HOP_BY_HOP, DEFAULT_API_VERSION };
