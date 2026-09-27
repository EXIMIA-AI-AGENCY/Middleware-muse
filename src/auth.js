'use strict';

const crypto = require('node:crypto');
const { sendJson } = require('./http-util');

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();

/**
 * Requires `X-Proxy-Key: <PROXY_KEY>`. Both sides are hashed first so the
 * comparison is constant-time and does not leak the key length.
 */
function requireProxyKey(proxyKey) {
  const expected = sha256(proxyKey);
  return (req, res, next) => {
    const provided = req.headers['x-proxy-key'];
    if (typeof provided === 'string' && provided.length > 0 && crypto.timingSafeEqual(sha256(provided), expected)) {
      return next();
    }
    res.locals.rejectedKey = true;
    return sendJson(res, 401, { error: 'unauthorized' });
  };
}

module.exports = { requireProxyKey };
