'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { createAdminRouter } = require('./admin');
const { requireProxyKey } = require('./auth');
const { sendJson } = require('./http-util');
const { requestLogger } = require('./logger');
const { createMetrics } = require('./metrics');
const { createForwarder } = require('./proxy');
const { createRateLimiter, rateLimitByKey } = require('./rate-limit');

/**
 * Routes:
 *   GET  /health  -> {"ok": true, "version": "..."}            (no auth)
 *   ALL  /ghl/*   -> https://services.leadconnectorhq.com/*    (X-Proxy-Key)
 *   ALL  /mcp/    -> https://services.leadconnectorhq.com/mcp/ (X-Proxy-Key)
 *   /api/kraken   -> signed Kraken calls (its own key; see src/kraken; only when passed in)
 *   /admin        -> operator dashboard (ADMIN_PIN session; only when ADMIN_PIN is set)
 *
 * `app.locals.selfUrl` (set by the caller once listening) lets the dashboard test the
 * proxy the same way Muse uses it.
 */
function createApp(config, logger, { adminOptions = {}, kraken = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');

  const limiter = createRateLimiter({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs });
  app.locals.limiter = limiter;
  const metrics = createMetrics();
  app.locals.metrics = metrics;
  // Marker the dashboard puts on its own test calls (never forwarded to GHL). Derived from
  // the proxy key so every instance recognises it; test calls do not use Muse's rate budget.
  const checkMarker = crypto.createHmac('sha256', config.proxyKey).update('ghl-proxy admin check v1').digest('hex');
  const isCheck = (req) => {
    const value = req.headers['x-admin-check'];
    return typeof value === 'string' && value.length === checkMarker.length &&
      crypto.timingSafeEqual(Buffer.from(value), Buffer.from(checkMarker));
  };

  app.use((req, res, next) => {
    res.locals.check = isCheck(req);
    next();
  });
  app.use(requestLogger(logger, metrics, (req, res) => res.locals.check));

  app.get('/health', (req, res) => {
    sendJson(res, 200, { ok: true, version: config.version });
  });

  // Kraken has its own key and limits, so it sits before the GHL key check below.
  if (kraken) app.use('/api/kraken', kraken.router);

  if (config.adminPin) {
    app.use('/admin', createAdminRouter({ config, logger, metrics, checkMarker, kraken, getSelfUrl: () => app.locals.selfUrl, ...adminOptions }));
    app.get('/', (req, res) => res.redirect(302, '/admin'));
  }

  // Everything below requires the proxy key.
  app.use(requireProxyKey(config.proxyKey));
  app.use(rateLimitByKey(limiter));

  app.use('/ghl', createForwarder(config, logger, { kind: 'rest', pathPrefix: '' }));
  app.use('/mcp', createForwarder(config, logger, { kind: 'mcp', pathPrefix: '/mcp' }));

  app.use((req, res) => {
    sendJson(res, 404, { error: 'not_found' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error({ msg: 'internal_error', name: err && err.name, code: err && err.code });
    if (res.headersSent) return res.destroy();
    return sendJson(res, 500, { error: 'internal_error' });
  });

  return app;
}

module.exports = { createApp };
