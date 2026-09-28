'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { sendJson } = require('../http-util');
const { createTiming } = require('../metrics');
const { HOP_BY_HOP } = require('./client');
const { explainStripeError, explainNoAnswer } = require('./explain');
const { stripePath, blockedBy, needsParams, strictParams, toForm, jsonKeys, jsonPairs, CANONICAL_KEY } = require('./guard');

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();
const same = (value, expectedHash) => typeof value === 'string' && value.length > 0 && crypto.timingSafeEqual(sha256(value), expectedHash);
const BODY_LIMIT = '1mb';
const MAX_ERROR_BODY = 256 * 1024;
const METHODS = new Set(['GET', 'POST', 'DELETE']);

/** The proxy's own answers use Stripe's error shape, plus the `proxy` explanation. */
function proxyError(res, status, code, message, proxy, headers) {
  return sendJson(res, status, { error: { type: 'proxy_error', code, message }, proxy: { summary: message, ...proxy } }, headers);
}

const isJson = (type) => /^application\/(.+\+)?json\b/i.test(type || '');
const isForm = (type) => /^application\/x-www-form-urlencoded\b/i.test(type || '');

/**
 * The Stripe API, mounted at /stripe:
 *   GET|POST|DELETE /stripe/v1/...  ->  https://api.stripe.com/v1/...   (X-Proxy-Key: Stripe key)
 * Its own key, limit and activity; the GHL and Kraken keys do not open it.
 *
 * - Money out (payouts, transfers, payout destinations) and lasting access grants (webhooks,
 *   public file links, login links) are refused unless the owner allows them.
 * - Every write must carry Muse's own Idempotency-Key, so it can be repeated (by the proxy
 *   or by Muse) without ever happening twice.
 * - The proxy repeats a call itself only when Stripe's rules say it is safe.
 * - v1 bodies sent as JSON are converted to the form encoding Stripe expects.
 * - Stripe errors come back as Stripe sent them plus a `proxy` object in Spanish.
 */
function createStripeRouter({ config, client, logger, metrics, limiter }) {
  const router = express.Router();
  const expectedKey = config.enabled ? sha256(config.accessKey) : null;
  const expectedMarker = config.enabled ? sha256(config.checkMarker) : null;
  const readBody = express.raw({ type: () => true, limit: BODY_LIMIT });

  router.use((req, res, next) => {
    res.locals.metrics = metrics;
    if (!config.enabled) {
      res.locals.check = false;
      return proxyError(res, 503, 'stripe_not_configured', 'La API de Stripe aún no está configurada en el servidor (falta STRIPE_SECRET_KEY). Avisa al usuario.', { safe_to_retry: 'no', next: 'Avisa al usuario.' });
    }
    // The panel's marked test calls (marker derived from the Stripe key) skip Muse's budget
    // and activity; the key is still required.
    res.locals.check = same(req.headers['x-stripe-check'], expectedMarker);
    if (!same(req.headers['x-proxy-key'], expectedKey)) {
      res.locals.rejectedKey = true;
      return proxyError(res, 401, 'unauthorized', 'Falta la llave del proxy para Stripe o no es la correcta. No se envió nada a Stripe.', { safe_to_retry: 'no', next: 'Usa la llave de Stripe (no la de GHL ni la de Kraken) en el header X-Proxy-Key.' });
    }
    if (!res.locals.check) {
      const { allowed, retryAfterMs } = limiter.hit('stripe-key');
      if (!allowed) {
        res.locals.rateLimited = true;
        const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
        return proxyError(res, 429, 'rate_limited', `Demasiadas llamadas seguidas. No se envió nada a Stripe.`, { safe_to_retry: 'after-wait', retry_after_seconds: seconds, next: `Espera ${seconds} s y repite.` }, { 'Retry-After': String(seconds) });
      }
    }
    return next();
  });

  router.use((req, res, next) => {
    if (!METHODS.has(req.method)) {
      return proxyError(res, 405, 'method_not_allowed', 'Stripe solo usa GET, POST y DELETE.', { safe_to_retry: 'no', next: 'Usa GET para leer, POST para crear o cambiar y DELETE para borrar.' }, { Allow: 'GET, POST, DELETE' });
    }
    const path = stripePath(req.url);
    if (path === null) {
      return proxyError(res, 400, 'invalid_path', 'La ruta no es válida: debe ser /v1/... o /v2/... de Stripe, sin "#", ";", "\\", "//", "." ni ".." y sin "/" codificado.', { safe_to_retry: 'no', next: 'Corrige la ruta. Ejemplo: /stripe/v1/customers?limit=10' });
    }
    res.locals.stripePath = path;
    return readBody(req, res, (err) => {
      if (err) {
        const tooBig = err.type === 'entity.too.large';
        return proxyError(res, tooBig ? 413 : 400, tooBig ? 'body_too_large' : 'bad_body', tooBig ? 'El cuerpo pasa de 1 MB. No se envió nada a Stripe.' : 'No se pudo leer el cuerpo. No se envió nada a Stripe.', { safe_to_retry: 'no', next: 'Corrige el cuerpo y reenvía.' });
      }
      return next();
    });
  });

  router.use(async (req, res, next) => {
    try {
      const path = res.locals.stripePath;
      const v1 = path.startsWith('/v1/');
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
      let body = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
      const headers = { ...req.headers };
      const extra = {};

      // v1 speaks form encoding; a JSON body is converted the way Stripe's libraries encode it.
      let json = null;
      if (body && isJson(headers['content-type'])) {
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          return proxyError(res, 400, 'bad_json', 'El cuerpo no es JSON válido. No se envió nada a Stripe.', { safe_to_retry: 'no', next: 'Corrige el JSON, o manda el cuerpo como application/x-www-form-urlencoded.' });
        }
        if (!json || typeof json !== 'object' || Array.isArray(json)) {
          return proxyError(res, 400, 'bad_json', 'El cuerpo JSON debe ser un objeto {...}. No se envió nada a Stripe.', { safe_to_retry: 'no', next: 'Manda los parámetros como un objeto JSON.' });
        }
        if (v1) {
          body = Buffer.from(toForm(json), 'utf8');
          headers['content-type'] = 'application/x-www-form-urlencoded';
          extra['X-Proxy-Converted'] = 'json-to-form';
        }
      }

      // Reads never carry a body to Stripe.
      if (req.method === 'GET') body = null;

      // Routes that are only dangerous with certain parameters: read them from query and body.
      let params = [];
      if (needsParams(req.method, path)) {
        const strict = strictParams(req.method, path);
        const pairs = (text) => [...new URLSearchParams(text).entries()];
        if (strict && (query.includes(';') || (body && body.includes(';')))) {
          return proxyError(res, 400, 'ambiguous_params', 'Los parámetros no pueden llevar ";". No se envió nada a Stripe.', { executed: 'no', safe_to_retry: 'no', next: 'Separa los parámetros solo con "&".' });
        }
        params = pairs(query);
        if (body) {
          if (json && !v1) params.push(...jsonPairs(json), ...jsonKeys(json).map((k) => [k, '']));
          else if (isForm(headers['content-type'])) params.push(...pairs(body.toString('utf8')));
          else {
            return proxyError(res, 415, 'unsupported_body', 'Para esta ruta manda el cuerpo como application/x-www-form-urlencoded o JSON. No se envió nada a Stripe.', { executed: 'no', safe_to_retry: 'no', next: 'Reenvía con Content-Type application/x-www-form-urlencoded.' });
          }
        }
        if (strict && params.some(([name]) => !CANONICAL_KEY.test(name))) {
          return proxyError(res, 400, 'ambiguous_params', 'Algún parámetro no tiene la forma normal de Stripe (nombre o nombre[clave]). No se envió nada a Stripe.', { executed: 'no', safe_to_retry: 'no', next: 'Escribe los parámetros como external_account o metadata[clave].' });
        }
      }

      const blocked = blockedBy(req.method, path, params, config);
      if (blocked) {
        res.locals.blocked = true;
        logger.warn({ msg: 'stripe_blocked', tier: blocked.tier });
        const switchName = blocked.tier === 'money_out' ? 'STRIPE_ALLOW_MONEY_OUT' : 'STRIPE_ALLOW_ACCESS_GRANTS';
        return proxyError(res, 403, 'blocked_by_proxy', `El proxy no permite ${blocked.what}: no se puede deshacer. No se envió nada a Stripe.`, {
          executed: 'no',
          safe_to_retry: 'no',
          next: `No insistas ni busques otra vía. Dile al usuario que lo haga él en el Dashboard de Stripe, o que el dueño lo permita en el servidor con ${switchName}=true.`,
        });
      }

      // Writes must carry Muse's own Idempotency-Key (v1: POST; v2: POST and DELETE): if an
      // answer is ever lost, Muse repeats with that same key and Stripe never acts twice.
      const keyed = req.method === 'POST' || (!v1 && req.method === 'DELETE');
      const given = typeof headers['idempotency-key'] === 'string' && headers['idempotency-key'].trim() ? headers['idempotency-key'].trim() : null;
      const idempotencyKey = keyed ? given : null;
      if (keyed && !idempotencyKey) {
        return proxyError(res, 400, 'idempotency_key_required', 'Falta el header Idempotency-Key. No se envió nada a Stripe.', {
          executed: 'no',
          safe_to_retry: 'yes',
          next: 'Repite la petición con el header Idempotency-Key: un UUID nuevo por cada acción distinta, y el MISMO si repites esa acción.',
        });
      }
      if (keyed && idempotencyKey.length > 255) {
        return proxyError(res, 400, 'idempotency_key_too_long', 'El Idempotency-Key pasa de 255 caracteres. No se envió nada a Stripe.', { executed: 'no', safe_to_retry: 'yes', next: 'Usa un UUID.' });
      }
      if (keyed) {
        headers['idempotency-key'] = idempotencyKey;
        extra['X-Proxy-Idempotency-Key'] = idempotencyKey;
      } else delete headers['idempotency-key'];

      const timing = createTiming(res.locals.startedAt);
      res.locals.timing = timing;
      let gone = false;
      res.once('close', () => {
        if (!res.writableFinished) gone = true;
      });

      const result = await client.call({ method: req.method, url: req.url, headers, body, repeatable: true, timing });
      if (gone) {
        if (result.res) result.res.resume();
        return undefined;
      }
      if (result.attempts > 1) extra['X-Proxy-Attempts'] = String(result.attempts);

      if (result.error) {
        res.locals.upstreamError = true;
        const timedOut = result.error === 'UPSTREAM_TIMEOUT';
        logger.error({ msg: timedOut ? 'stripe_timeout' : 'stripe_unreachable', code: result.error, attempts: result.attempts });
        const proxy = explainNoAnswer({ method: req.method, sent: result.sent, timedOut, idempotencyKey, attempts: result.attempts });
        return proxyError(res, timedOut ? 504 : 502, timedOut ? 'upstream_timeout' : 'upstream_unreachable', proxy.summary, proxy, extra);
      }

      const upstream = result.res;
      const status = upstream.statusCode;
      const outHeaders = {};
      for (const [name, value] of Object.entries(upstream.headers)) if (!HOP_BY_HOP.has(name)) outHeaders[name] = value;
      Object.assign(outHeaders, extra, { 'Cache-Control': 'no-store' });
      if (res.locals.check) outHeaders['X-Proxy-Overhead-Ms'] = timing.overheadSoFar().toFixed(2);

      // Errors: Stripe's answer plus the `proxy` explanation. Successes stream through untouched.
      if (status >= 400) {
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of upstream) {
            size += chunk.length;
            if (size > MAX_ERROR_BODY) break;
            chunks.push(chunk);
          }
        } catch {
          // The error answer broke off: Muse still gets the explanation below.
          chunks.length = 0;
        }
        if (size > MAX_ERROR_BODY) upstream.destroy();
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (!upstream.headers['content-encoding']) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
        }
        const proxy = explainStripeError({ method: req.method, status, headers: upstream.headers, body: parsed, idempotencyKey, attempts: result.attempts, maybeRan: result.maybeRan });
        const answer =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? { ...parsed, proxy }
            : { error: { type: 'api_error', message: `Stripe respondió HTTP ${status} sin un error legible.` }, proxy, upstream_body: upstream.headers['content-encoding'] ? undefined : text.slice(0, 500) };
        const payload = Buffer.from(JSON.stringify(answer), 'utf8');
        for (const name of ['content-length', 'content-encoding', 'content-type']) delete outHeaders[name];
        outHeaders['Content-Type'] = 'application/json; charset=utf-8';
        outHeaders['Content-Length'] = String(payload.length);
        res.writeHead(status, outHeaders);
        timing.relayed();
        return res.end(payload);
      }
      res.writeHead(status, outHeaders);
      timing.relayed();
      upstream.on('error', () => res.destroy());
      upstream.pipe(res);
      return undefined;
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = { createStripeRouter };
