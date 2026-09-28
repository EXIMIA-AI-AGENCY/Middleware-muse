'use strict';

const http = require('node:http');
const https = require('node:https');
const { version } = require('../../package.json');
const { lookupError, errorsOf, throttledWaitSeconds } = require('./errors');
const { sign, createNonceSource } = require('./sign');

const USER_AGENT = `ghl-proxy-kraken/${version}`;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE = 30;
const ATTEMPT_TIMEOUT_MS = 15_000;
const STATUS_CACHE_MS = 10_000;
const STATUS_TIMEOUT_MS = 4_000;
const PAIR_CACHE_MS = 10 * 60_000;
// Kraken's temporary lockout lasts about 15 minutes and every new call restarts it.
const LOCKOUT_PAUSE_MS = 15 * 60_000;

/**
 * How each kind of call may be retried.
 *  read    reads (and GetWebSocketsToken): safe to repeat.
 *  cancel  CancelOrder, CancelAll, CancelOrderBatch, CancelAllOrdersAfter: repeating is harmless.
 *  create  AddOrder, AddOrderBatch, AmendOrder: repeated ONLY when Kraken certainly did not run
 *          it (rejected before execution, or the request never left). Always on a new
 *          connection, so a failure to connect proves the order was not sent.
 */
const POLICIES = {
  read: { budgetMs: 25_000, fresh: false },
  cancel: { budgetMs: 25_000, fresh: false },
  create: { budgetMs: 15_000, fresh: true },
};
// Reads that cost more on Kraken's rate counter (support article: +4), so they need a longer wait.
const HISTORY = new Set(['Ledgers', 'TradesHistory', 'ClosedOrders']);
// Cloudflare answers meaning Kraken's servers never received the request.
const NEVER_RECEIVED = new Set([521, 523, 525, 526]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * A JS number as a plain decimal string. Kraken wants decimals like "0.0000001"; String()
 * would give "1e-7" for very small or very large values.
 */
function plainNumber(n) {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  const [mantissa, exponent] = s.toLowerCase().split('e');
  const negative = mantissa.startsWith('-');
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const dot = unsigned.indexOf('.');
  const digits = unsigned.replace('.', '');
  const point = (dot === -1 ? unsigned.length : dot) + Number(exponent);
  let out;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return negative ? `-${out}` : out;
}

/**
 * Body for a private call: form-urlencoded with the nonce first (Kraken's documented format)
 * when every value is flat; JSON when a value is an array or object (AddOrderBatch,
 * CancelOrderBatch), since form encoding has no documented form for those. Either way the
 * signature covers exactly these bytes. Values are expected already normalized (params.js).
 */
function encodeBody(params, nonce) {
  const nested = Object.values(params).some((v) => v !== null && typeof v === 'object');
  if (nested) {
    return { body: JSON.stringify({ nonce: Number(nonce), ...params }), contentType: 'application/json' };
  }
  const form = new URLSearchParams();
  form.append('nonce', nonce);
  for (const [key, value] of Object.entries(params)) form.append(key, typeof value === 'number' ? plainNumber(value) : String(value));
  return { body: form.toString(), contentType: 'application/x-www-form-urlencoded' };
}

/**
 * Whether (and after how long) to repeat a private call, given its latest answer.
 * Returns the wait in ms, or null to stop. Never repeats a create call unless Kraken
 * certainly did not run it.
 */
function retryWait(policy, method, res, attempt, remainingMs, nowMs) {
  const fits = (ms) => (ms + 1000 < remainingMs ? ms : null);
  const repeatable = policy !== 'create';
  if (res.status === 0) {
    if (res.error !== 'timeout' && res.error !== 'network') return null; // busy, locked, expired, too_large
    if (res.notSent) return attempt <= 2 ? fits(attempt === 1 ? 1000 : 2000) : null;
    // A kept-alive socket that had gone stale: a read can go again right away.
    if (repeatable && res.reused && res.error === 'network' && attempt === 1) return 0;
    return repeatable && attempt <= 2 ? fits(attempt === 1 ? 1000 : 3000) : null;
  }
  if (!res.json) {
    if (NEVER_RECEIVED.has(res.status)) return attempt <= 2 ? fits(attempt === 1 ? 1000 : 2000) : null;
    return repeatable && attempt <= 2 && (res.status >= 500 || res.status === 408 || res.status === 429) ? fits(attempt === 1 ? 1000 : 3000) : null;
  }
  const first = errorsOf(res.json)[0];
  if (!first) return null;
  const info = lookupError(first);
  switch (info.kind) {
    case 'nonce':
      return attempt <= 2 ? fits(attempt === 1 ? 300 + Math.floor(Math.random() * 200) : 1000) : null;
    case 'rate': {
      if (attempt > 1) return null;
      if (info.code === 'EGeneral:Too many requests') return fits(5000);
      if (info.code && info.code.startsWith('EAuth')) return null;
      return fits(policy === 'read' && HISTORY.has(method) ? 13_000 : 4000);
    }
    case 'throttled': {
      if (attempt > 1) return null;
      const seconds = throttledWaitSeconds(first, nowMs);
      return fits(seconds === null ? 5000 : Math.ceil(seconds * 1000) + 250);
    }
    case 'orderRate':
      return policy === 'create' && attempt <= 2 ? fits(attempt === 1 ? 2000 : 4000) : null;
    case 'transient':
      return repeatable && attempt <= 2 ? fits(attempt === 1 ? 1000 : 3000) : null;
    default:
      return null;
  }
}

/**
 * Talks to api.kraken.com. Private calls go out one at a time per process: the nonce is
 * taken right before sending, so within one instance they always reach Kraken in order.
 * Retries (see retryWait) happen inside the call's turn. Nothing here logs or returns keys,
 * signatures or request bodies.
 */
function createKrakenClient(config, { now = () => Date.now(), timeoutMs = ATTEMPT_TIMEOUT_MS, policies = POLICIES } = {}) {
  const base = config.baseUrl;
  const transport = base.protocol === 'https:' ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 8 });
  const nextNonce = createNonceSource(now);
  let queue = Promise.resolve();
  let queued = 0;
  let statusCache = null;
  const pairCache = new Map();
  let lockedUntil = 0;

  function send(method, path, { headers = {}, body, timeout = timeoutMs, fresh = false } = {}) {
    return new Promise((resolve) => {
      const started = process.hrtime.bigint();
      const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
      let deadline = null;
      let connected = false;
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(result);
      };
      const req = transport.request(
        new URL(path, base),
        { method, agent: fresh ? false : agent, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers } },
        (res) => {
          const chunks = [];
          let size = 0;
          const trace = { traceId: res.headers['x-trace-id'] || null, cfRay: res.headers['cf-ray'] || null };
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              res.destroy();
              finish({ status: 0, error: 'too_large', ms: elapsed(), ...trace });
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            finish({ status: res.statusCode, text, json: parseJson(text), ms: elapsed(), ...trace });
          });
          res.on('error', () => finish({ status: 0, error: 'network', ms: elapsed(), ...trace }));
          res.on('aborted', () => finish({ status: 0, error: 'network', ms: elapsed(), ...trace }));
        },
      );
      // Did the request reach a connected socket? If not, Kraken cannot have received it.
      req.on('socket', (socket) => {
        if (!socket.connecting) connected = true; // a kept-alive socket
        else socket.once(transport === https ? 'secureConnect' : 'connect', () => { connected = true; });
      });
      // One deadline for the whole exchange: a slow trickle of bytes cannot hold the queue.
      deadline = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'KRAKEN_TIMEOUT' })), timeout);
      req.on('error', (err) => {
        const timedOut = err.code === 'KRAKEN_TIMEOUT';
        finish({ status: 0, error: timedOut ? 'timeout' : 'network', notSent: !connected, reused: Boolean(req.reusedSocket), ms: elapsed() });
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  async function systemStatus() {
    if (statusCache && now() - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
    const res = await send('GET', '/0/public/SystemStatus', { timeout: STATUS_TIMEOUT_MS });
    const status = res.json && res.json.result && typeof res.json.result.status === 'string' ? res.json.result.status : null;
    statusCache = { at: now(), value: status };
    return status;
  }

  async function signedCall(method, params, { policy, budgetMs, isCancelled }) {
    const path = `/0/private/${method}`;
    const started = now();
    const attempts = [];
    let krakenStatus;
    for (;;) {
      const remaining = budgetMs - (now() - started);
      const nonce = nextNonce();
      const { body, contentType } = encodeBody(params, nonce);
      const headers = {
        'API-Key': config.apiKey,
        'API-Sign': sign({ secret: config.secret, uriPath: path, nonce, postData: body }),
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(body),
      };
      const res = await send('POST', path, { headers, body, timeout: Math.max(1000, Math.min(timeoutMs, remaining)), fresh: policies[policy].fresh });
      const first = errorsOf(res.json)[0] || null;
      const info = first ? lookupError(first) : null;
      attempts.push({ status: res.status, error: res.error || null, krakenError: first, notSent: res.notSent || false, ms: Math.round(res.ms) });
      if (info && info.kind === 'lockout') {
        lockedUntil = now() + LOCKOUT_PAUSE_MS;
        return { ...res, attempts, krakenStatus };
      }
      if (info && info.code === 'EService:Unavailable') {
        krakenStatus = await systemStatus();
        if (krakenStatus === 'maintenance') return { ...res, attempts, krakenStatus };
      }
      const wait = retryWait(policy, method, res, attempts.length, budgetMs - (now() - started), now());
      if (wait === null) return { ...res, attempts, krakenStatus };
      attempts[attempts.length - 1].retriedAfterMs = wait;
      await sleep(wait);
      // A retry is a new request: never send one nobody is waiting for.
      if (isCancelled()) {
        delete attempts[attempts.length - 1].retriedAfterMs;
        return { ...res, attempts, krakenStatus, callerGone: true };
      }
    }
  }

  return {
    /**
     * Signed call to /0/private/<method>. `method` must already be allowlisted and `params`
     * normalized. `policy` picks the retry rules. `isCancelled()` is checked before signing
     * and before every retry, so nothing is sent once the caller has hung up. `deadlineAt`
     * (ms epoch) caps the whole call including the wait in the queue: past it, the call is not
     * sent ('expired'). Returns the last answer plus `attempts` (one per try) and `waitMs`.
     */
    privateCall(method, params = {}, { policy = 'read', isCancelled = () => false, budgetMs, deadlineAt } = {}) {
      if (!policies[policy]) throw new Error(`unknown policy ${policy}`);
      if (now() < lockedUntil) return Promise.resolve({ status: 0, error: 'locked', lockedUntil, ms: 0, attempts: [] });
      if (queued >= MAX_QUEUE) return Promise.resolve({ status: 0, error: 'busy', ms: 0, attempts: [] });
      queued += 1;
      const enqueuedAt = now();
      const run = queue.then(async () => {
        const waitMs = now() - enqueuedAt;
        if (isCancelled()) return { status: 0, error: 'cancelled', ms: 0, attempts: [], waitMs };
        if (now() < lockedUntil) return { status: 0, error: 'locked', lockedUntil, ms: 0, attempts: [], waitMs };
        let budget = budgetMs ?? policies[policy].budgetMs;
        if (deadlineAt) budget = Math.min(budget, deadlineAt - now());
        if (budget < 1000) return { status: 0, error: 'expired', notSent: true, ms: 0, attempts: [], waitMs };
        const res = await signedCall(method, params, { policy, budgetMs: budget, isCancelled });
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

    /**
     * Kraken's own status ("online", "maintenance", "cancel_only", "post_only", …), used to
     * explain failures. Cached briefly; null when Kraken does not answer.
     */
    systemStatus,

    /**
     * A pair's trading rules from public AssetPairs (status, minimums, decimals), cached for
     * 10 minutes; null if Kraken does not know the pair or does not answer.
     */
    async pairInfo(pair) {
      if (typeof pair !== 'string' || !/^[A-Za-z0-9./:_-]{2,32}$/.test(pair)) return null;
      const cached = pairCache.get(pair);
      if (cached && now() - cached.at < PAIR_CACHE_MS) return cached.value;
      const res = await send('GET', `/0/public/AssetPairs?pair=${encodeURIComponent(pair)}`, { timeout: STATUS_TIMEOUT_MS });
      const entries = res.json && res.json.result && typeof res.json.result === 'object' ? Object.entries(res.json.result) : [];
      if (!entries.length) return null;
      const [name, p] = entries[0];
      const value = {
        name,
        altname: p.altname ?? null,
        status: p.status ?? null,
        ordermin: p.ordermin ?? null,
        costmin: p.costmin ?? null,
        tick_size: p.tick_size ?? null,
        lot_decimals: p.lot_decimals ?? null,
        pair_decimals: p.pair_decimals ?? null,
      };
      pairCache.set(pair, { at: now(), value });
      return value;
    },

    /** Until when calls are paused after Kraken's temporary lockout (ms epoch; 0 = not paused). */
    lockedUntil: () => (now() < lockedUntil ? lockedUntil : 0),
  };
}

module.exports = { createKrakenClient, encodeBody, plainNumber, retryWait, USER_AGENT, POLICIES };
