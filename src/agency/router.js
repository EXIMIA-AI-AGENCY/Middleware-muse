'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { sendJson } = require('../http-util');
const { canonicalPath } = require('../canonical-path');
const { createForwarder } = require('../proxy');

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();
const same = (value, expectedHash) => typeof value === 'string' && value.length > 0 && crypto.timingSafeEqual(sha256(value), expectedHash);
// SaaS routes answer only to this Version (GHL docs); every other agency route uses the default.
const SAAS_VERSION = '2021-04-15';
// Headers some servers read as "treat this POST as another method": never relayed.
const METHOD_OVERRIDE = ['x-http-method-override', 'x-http-method', 'x-method-override'];

const isSubAccountDelete = (method, path) => method === 'DELETE' && /^\/locations\/[^/]+$/.test(path);

/**
 * The agency API, mounted at /agency: the same REST passthrough as the Eximia proxy (/ghl),
 * but with the AGENCY token and its own key, limit and activity.
 *   ALL /agency/*  ->  https://services.leadconnectorhq.com/*   (X-Proxy-Key: agency key)
 * The Eximia key does not open it, and the agency key does not open /ghl or /mcp.
 *
 * What GHL lets an agency token do (sub-accounts, users, snapshots, SaaS, company, menus) is
 * GHL's decision; the proxy passes everything through, except deleting sub-accounts, which
 * cannot be undone and stays off unless GHL_AGENCY_ALLOW_DELETE is exactly "true".
 */
function createAgencyRouter({ config, ghlConfig, logger, metrics, limiter }) {
  const router = express.Router();
  const expectedKey = config.enabled ? sha256(config.accessKey) : null;
  const expectedMarker = config.enabled ? sha256(config.checkMarker) : null;
  // No default locationId: agency calls name their sub-account (or company) themselves.
  const upstream = config.enabled ? { ...ghlConfig, ghlToken: config.token, ghlLocationId: null } : null;
  const forward = upstream ? createForwarder(upstream, logger, { kind: 'rest', pathPrefix: '' }) : null;

  router.use((req, res, next) => {
    // This API has its own activity in the panel, apart from Eximia's.
    res.locals.metrics = metrics;
    if (!config.enabled) {
      res.locals.check = false;
      return sendJson(res, 503, { error: 'agency_not_configured', message: 'The agency API is not configured on the server yet (GHL_AGENCY_TOKEN).' });
    }
    // The panel's marked test calls (marker derived from the agency token; the Eximia marker is
    // ignored here) neither use Muse's budget nor show up as Muse's activity. The key is still required.
    res.locals.check = same(req.headers['x-agency-check'], expectedMarker);
    if (!same(req.headers['x-proxy-key'], expectedKey)) {
      res.locals.rejectedKey = true;
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    if (!res.locals.check) {
      const { allowed, retryAfterMs } = limiter.hit('agency-key');
      if (!allowed) {
        res.locals.rateLimited = true;
        return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });
      }
    }
    return next();
  });

  router.use((req, res, next) => {
    // A fragment is never valid in a request (RFC 9112 §3.2); upstream parsers would cut the
    // path there, so it could hide a route from the guard below.
    if (req.url.includes('#')) return sendJson(res, 400, { error: 'bad_request', message: 'The path cannot contain "#".' });
    const path = canonicalPath(req.url);
    // Only the delete guard needs the decoded path; other methods pass through untouched.
    if (path === null && req.method === 'DELETE') return sendJson(res, 400, { error: 'bad_request', message: 'The path has invalid percent-encoding.' });
    for (const name of METHOD_OVERRIDE) delete req.headers[name];
    if (path !== null && isSubAccountDelete(req.method, path) && !config.allowDelete) {
      res.locals.blocked = true;
      logger.warn({ msg: 'agency_delete_blocked' });
      return sendJson(res, 403, {
        error: 'blocked_by_proxy',
        message: 'Deleting a sub-account cannot be undone, so the proxy does not allow it. Nothing was sent to GoHighLevel. Tell the user: they can delete it in GoHighLevel themselves, or the owner can allow it on the proxy with GHL_AGENCY_ALLOW_DELETE=true.',
      });
    }
    const saasPath = path ?? req.url.split('?', 1)[0].toLowerCase();
    if (!req.headers.version && /^\/saas(-api)?\//.test(saasPath)) req.headers.version = SAAS_VERSION;
    return forward(req, res, next);
  });
  return router;
}

module.exports = { createAgencyRouter, canonicalPath, SAAS_VERSION };
