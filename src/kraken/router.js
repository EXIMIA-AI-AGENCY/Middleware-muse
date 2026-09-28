'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { checkMethod } = require('./methods');

const BODY_LIMIT = '64kb';
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_PARAMS = 50;
const MAX_VALUE_LENGTH = 4096;
// Only these take arrays/objects (their `orders` list); they are trading methods.
const NESTED_OK = new Set(['AddOrderBatch', 'CancelOrderBatch']);
const HINT = 'send a JSON object like {"method":"Balance","params":{}}';

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Kraken-shaped error, so Muse handles proxy and Kraken errors the same way. */
function reply(res, status, error, headers = {}) {
  const payload = JSON.stringify({ error: [error] });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function checkParams(method, params) {
  const entries = Object.entries(params);
  if (entries.length > MAX_PARAMS) return `EProxy:Too many params (max ${MAX_PARAMS})`;
  for (const [key, value] of entries) {
    if (!PARAM_NAME.test(key)) return 'EProxy:Invalid param name (letters, digits and _ only)';
    if (key === 'nonce') return 'EProxy:Do not send nonce; the proxy sets it';
    if (typeof value === 'string') {
      if (value.length > MAX_VALUE_LENGTH) return `EProxy:Param ${key} is too long`;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) return `EProxy:Param ${key} must be a finite number`;
    } else if (typeof value === 'boolean') {
      // fine
    } else if (value !== null && typeof value === 'object' && NESTED_OK.has(method)) {
      // arrays/objects only for batch orders; sent as JSON
    } else {
      return `EProxy:Param ${key} must be a string, number or boolean`;
    }
  }
  return null;
}

/**
 * DepositAddresses can create things: `new` generates a new address (Kraken may treat the
 * flag as set whenever it is present, even as "false") and `amount` makes a Lightning
 * invoice. Only plain reads of existing addresses are let through.
 */
function createsDepositAddress(method, params) {
  return method === 'DepositAddresses' && (Object.hasOwn(params, 'new') || Object.hasOwn(params, 'amount'));
}

function clientIp(req, trustForwardedFor) {
  if (trustForwardedFor) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * POST /api/kraken  {method, params}  -> Kraken's JSON as-is   (X-Proxy-Key: Kraken access key)
 * GET  /api/kraken?health=1           -> {"ok": true}           (no auth)
 *
 * Order: configured? -> key -> 60/min per IP -> body -> method allowlist -> params -> Kraken.
 * Nothing before the last step talks to Kraken. Calls with a valid key and calls without one
 * are counted in separate per-IP buckets, so failed attempts from a shared address can never
 * use up Muse's budget.
 */
function createKrakenRouter({ config, client, metrics, limiter, logger }) {
  const router = express.Router();
  const expected = config.enabled ? sha256(config.accessKey) : null;
  const expectedMarker = config.enabled ? sha256(config.checkMarker) : null;
  // The panel's own test calls (marker derived from the Kraken secret; the GHL marker is ignored).
  const isPanelCheck = (req) => {
    const value = req.headers['x-kraken-check'];
    return Boolean(expectedMarker) && typeof value === 'string' && value.length > 0 && crypto.timingSafeEqual(sha256(value), expectedMarker);
  };
  const readBody = express.text({ type: () => true, limit: BODY_LIMIT });

  router.get('/', (req, res) => {
    if (req.query.health !== undefined) {
      if (!config.enabled) return reply(res, 503, 'EProxy:Kraken is not configured on the server');
      const payload = JSON.stringify({ ok: true });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' });
      return res.end(payload);
    }
    return reply(res, 405, `EProxy:Use POST; ${HINT}`, { Allow: 'GET, POST' });
  });

  router.post('/', (req, res, next) => {
    const started = process.hrtime.bigint();
    let check = false;
    const done = (status, fields = {}) =>
      metrics.record({ check, status, totalMs: Number(process.hrtime.bigint() - started) / 1e6, ...fields });

    if (!config.enabled) {
      done(503, { error: 'EProxy:Not configured' });
      return reply(res, 503, 'EProxy:Kraken is not configured on the server');
    }

    const provided = req.headers['x-proxy-key'];
    const keyOk = typeof provided === 'string' && provided.length > 0 && crypto.timingSafeEqual(sha256(provided), expected);
    // The panel's marked test calls neither use Muse's budget nor show up as Muse's activity.
    check = keyOk && isPanelCheck(req);
    if (!check) {
      const bucket = `${clientIp(req, config.trustForwardedFor)}|${keyOk ? 'key' : 'nokey'}`;
      const { allowed, retryAfterMs } = limiter.hit(bucket);
      if (!allowed) {
        done(429, { rateLimited: true, error: 'EProxy:Rate limit' });
        return reply(res, 429, 'EProxy:Rate limit exceeded (60 per minute)', { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });
      }
    }
    if (!keyOk) {
      done(401, { rejectedKey: true, error: 'EProxy:Unauthorized' });
      return reply(res, 401, 'EProxy:Unauthorized');
    }

    // Muse hung up (or its platform timed out): a call still waiting in the queue is dropped.
    let gone = false;
    res.once('close', () => {
      if (!res.writableFinished) gone = true;
    });

    return readBody(req, res, async (err) => {
      try {
        if (err) {
          const tooLarge = err.type === 'entity.too.large';
          done(tooLarge ? 413 : 400, { error: 'EProxy:Bad body' });
          return reply(res, tooLarge ? 413 : 400, tooLarge ? `EProxy:Body too large (max ${BODY_LIMIT})` : `EProxy:Unreadable body; ${HINT}`);
        }
        const body = typeof req.body === 'string' && req.body.length ? parseBody(req.body) : null;
        const bad = (status, error) => {
          done(status, { method: body && typeof body.method === 'string' ? body.method.slice(0, 40) : null, error });
          return reply(res, status, error);
        };
        if (!isPlainObject(body)) return bad(400, `EProxy:Invalid JSON body; ${HINT}`);
        if (typeof body.method !== 'string' || body.method.length === 0) return bad(400, 'EProxy:method must be a non-empty string');
        const params = body.params === undefined ? {} : body.params;
        if (!isPlainObject(params)) return bad(400, 'EProxy:params must be a JSON object');

        const allowed = checkMethod(body.method, { trading: config.trading });
        if (!allowed.ok) return bad(allowed.status, allowed.error);
        const paramError = checkParams(allowed.method, params);
        if (paramError) return bad(400, paramError);
        if (createsDepositAddress(allowed.method, params)) {
          return bad(403, 'EProxy:DepositAddresses may only read existing addresses (new and amount are not allowed)');
        }

        const result = await client.privateCall(allowed.method, params, { readOnly: allowed.readOnly, isCancelled: () => gone });
        if (result.error === 'cancelled') {
          done(499, { method: allowed.method, error: 'EProxy:Caller hung up before sending' });
          return undefined;
        }
        const krakenError = result.json && Array.isArray(result.json.error) && result.json.error.length ? String(result.json.error[0]).slice(0, 120) : null;
        const fields = { method: allowed.method, krakenMs: result.ms, attempts: result.attempts };
        logger.info({ msg: 'kraken_call', method: allowed.method, status: result.status, krakenMs: Math.round(result.ms), attempts: result.attempts, krakenError, check });

        if (result.status === 0) {
          // For trading, a lost answer does not mean the order was not placed.
          const unknown = allowed.readOnly ? '' : '; the order may or may not have been placed: check OpenOrders/ClosedOrders before retrying';
          const [status, error] =
            result.error === 'timeout' ? [504, `EProxy:Kraken did not answer in time${unknown}`]
              : result.error === 'busy' ? [503, 'EProxy:Too many Kraken calls waiting; retry in a few seconds']
                : [502, `EProxy:Could not reach Kraken${unknown}`];
          done(status, { ...fields, upstreamError: true, error });
          return reply(res, status, error);
        }
        if (!result.json) {
          done(502, { ...fields, upstreamError: true, error: `EProxy:Unexpected response (HTTP ${result.status})` });
          return reply(res, 502, `EProxy:Kraken returned an unexpected response (HTTP ${result.status})`);
        }
        done(result.status, { ...fields, error: krakenError });
        // Kraken's JSON, byte for byte.
        res.writeHead(result.status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(result.text),
          'Cache-Control': 'no-store',
        });
        return res.end(result.text);
      } catch (e) {
        return next(e);
      }
    });
  });

  router.all('/', (req, res) => reply(res, 405, `EProxy:Use POST; ${HINT}`, { Allow: 'GET, POST' }));
  router.use((req, res) => reply(res, 404, 'EProxy:Not found; the endpoint is POST /api/kraken'));
  return router;
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { createKrakenRouter, checkParams, createsDepositAddress, clientIp };
