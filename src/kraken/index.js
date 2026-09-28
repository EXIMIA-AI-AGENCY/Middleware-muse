'use strict';

const { createRateLimiter } = require('../rate-limit');
const { mountKrakenAdmin } = require('./admin');
const { createKrakenClient } = require('./client');
const { loadKrakenConfig } = require('./config');
const { createKrakenMetrics } = require('./metrics');
const { createKrakenRouter } = require('./router');

/**
 * The Kraken module, side by side with the GoHighLevel proxy and independent from it:
 * its own key, limits, metrics and errors. Missing or wrong Kraken settings only disable
 * /api/kraken; they never affect /ghl or /mcp.
 */
function createKraken({ env = process.env, ghlConfig, logger, clientOptions } = {}) {
  const config = loadKrakenConfig(env, { ghl: ghlConfig });
  const client = createKrakenClient(config, clientOptions);
  const metrics = createKrakenMetrics();
  const limiter = createRateLimiter({ max: config.rateLimitMax, windowMs: config.rateLimitWindowMs });
  const router = createKrakenRouter({ config, client, metrics, limiter, logger });
  return {
    config,
    client,
    metrics,
    limiter,
    router,
    mountAdmin: (adminRouter, helpers) => mountKrakenAdmin(adminRouter, { config, client, metrics, logger, version: ghlConfig && ghlConfig.version, ...helpers }),
  };
}

/** For the entrypoints: never throws, so a Kraken problem can never take GHL down. */
function tryCreateKraken(options) {
  try {
    const kraken = createKraken(options);
    options.logger.info({ msg: 'kraken', enabled: kraken.config.enabled, trading: kraken.config.trading });
    return kraken;
  } catch (err) {
    options.logger.error({ msg: 'kraken_disabled', name: err && err.name });
    return null;
  }
}

module.exports = { createKraken, tryCreateKraken };
