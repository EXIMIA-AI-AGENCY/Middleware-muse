'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { sendJson } = require('../http-util');
const { createForwarder } = require('../proxy');

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();
const same = (value, expectedHash) => typeof value === 'string' && value.length > 0 && crypto.timingSafeEqual(sha256(value), expectedHash);

/**
 * The agency API, mounted at /agency. Same passthrough as the Eximia proxy (/ghl, /mcp) but
 * with the AGENCY token and its own key, limit and activity:
 *   ALL  /agency/*      -> https://services.leadconnectorhq.com/*      (X-Proxy-Key: agency key)
 *   POST /agency/mcp/   -> https://services.leadconnectorhq.com/mcp/   (X-Proxy-Key: agency key)
 * The Eximia key does not open it, and the agency key does not open /ghl or /mcp.
 */
function createAgencyRouter({ config, ghlConfig, logger, metrics, limiter, extraRoutes }) {
  const router = express.Router();
  const expectedKey = config.enabled ? sha256(config.accessKey) : null;
  const expectedMarker = config.enabled ? sha256(config.checkMarker) : null;
  // The forwarder reads the token, location and defaults from its config.
  const upstream = config.enabled ? { ...ghlConfig, ghlToken: config.token, ghlLocationId: null } : null;

  router.use((req, res, next) => {
    // This API has its own activity in the panel, apart from Eximia's.
    res.locals.metrics = metrics;
    // Only the agency panel marker counts as a panel test here (not the Eximia one).
    res.locals.check = false;
    if (!config.enabled) return sendJson(res, 503, { error: 'agency_not_configured', message: 'The agency API is not configured on the server (GHL_AGENCY_TOKEN).' });
    if (!same(req.headers['x-proxy-key'], expectedKey)) {
      res.locals.rejectedKey = true;
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    res.locals.check = same(req.headers['x-agency-check'], expectedMarker);
    if (!res.locals.check) {
      const { allowed, retryAfterMs } = limiter.hit('agency-key');
      if (!allowed) {
        res.locals.rateLimited = true;
        return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });
      }
    }
    return next();
  });

  if (upstream) {
    if (extraRoutes) extraRoutes(router, upstream);
    router.use('/mcp', createForwarder(upstream, logger, { kind: 'mcp', pathPrefix: '/mcp' }));
    router.use(createForwarder(upstream, logger, { kind: 'rest', pathPrefix: '' }));
  }
  return router;
}

module.exports = { createAgencyRouter };
