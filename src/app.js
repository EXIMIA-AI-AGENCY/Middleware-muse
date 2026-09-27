'use strict';

const express = require('express');
const { requireProxyKey } = require('./auth');
const { sendJson } = require('./http-util');
const { requestLogger } = require('./logger');
const { createForwarder } = require('./proxy');
const { createRateLimiter, rateLimitByKey } = require('./rate-limit');

/**
 * Routes:
 *   GET  /health  -> {"ok": true, "version": "..."}            (no auth)
 *   ALL  /ghl/*   -> https://services.leadconnectorhq.com/*    (X-Proxy-Key)
 *   ALL  /mcp/    -> https://services.leadconnectorhq.com/mcp/ (X-Proxy-Key)
 */
function createApp(config, logger) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');

  const limiter = createRateLimiter({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs });
  app.locals.limiter = limiter;

  app.use(requestLogger(logger));

  app.get('/health', (req, res) => {
    sendJson(res, 200, { ok: true, version: config.version });
  });

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
