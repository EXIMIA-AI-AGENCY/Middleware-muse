'use strict';

const { createMetrics } = require('../metrics');
const { createRateLimiter } = require('../rate-limit');
const { mountAgencyAdmin } = require('./admin');
const { loadAgencyConfig } = require('./config');
const { createAgencyRouter } = require('./router');

/**
 * The GHL agency API, side by side with the Eximia sub-account proxy and independent from it:
 * its own token, key, limit and activity. Missing or wrong agency settings only disable
 * /agency; they never affect /ghl, /mcp or Kraken.
 */
function createAgency({ env = process.env, ghlConfig, logger, others = [] } = {}) {
  const config = loadAgencyConfig(env, { ghl: ghlConfig, others });
  const metrics = createMetrics();
  // Same budget as the Eximia proxy (GHL allows 100 calls / 10 s per token and resource).
  const limiter = createRateLimiter({ max: ghlConfig.rateLimitMax, windowMs: ghlConfig.rateLimitWindowMs });
  const router = createAgencyRouter({ config, ghlConfig, logger, metrics, limiter });
  return {
    config,
    metrics,
    limiter,
    router,
    mountAdmin: (adminRouter, helpers) => mountAgencyAdmin(adminRouter, { config, ghlConfig, metrics, logger, ...helpers }),
  };
}

/** For the entrypoints: never throws, so an agency problem can never take the rest down. */
function tryCreateAgency(options) {
  try {
    const agency = createAgency(options);
    options.logger.info({ msg: 'ghl_agency', enabled: agency.config.enabled });
    return agency;
  } catch (err) {
    options.logger.error({ msg: 'ghl_agency_disabled', name: err && err.name });
    return null;
  }
}

module.exports = { createAgency, tryCreateAgency };
