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
 *   /admin        -> operator dashboard (ADMIN_PIN session; only when ADMIN_PIN is set)
 *
 * `app.locals.selfUrl` (set by the caller once listening) lets the dashboard test the
 * proxy the same way Muse uses it.
 */
function createApp(config, logger, { adminOptions = {} } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');

  const limiter = createRateLimiter({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs });
  app.locals.limiter = limiter;
  const metrics = createMetrics();
  app.locals.metrics = metrics;
  // Per-process marker the dashboard puts on its own test calls (never forwarded to GHL).
  const checkMarker = crypto.randomBytes(16).toString('hex');
  const isCheck = (req) => req.headers['x-admin-check'] === checkMarker;

  app.use(requestLogger(logger, metrics, isCheck));

  app.get('/health', (req, res) => {
    sendJson(res, 200, { ok: true, version: config.version });
  });

  if (config.adminPin) {
    app.use('/admin', createAdminRouter({ config, logger, metrics, checkMarker, getSelfUrl: () => app.locals.selfUrl, ...adminOptions }));
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
