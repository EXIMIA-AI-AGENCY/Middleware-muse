'use strict';

const { createMetrics } = require('../metrics');
const { createRateLimiter } = require('../rate-limit');
const { mountStripeAdmin } = require('./admin');
const { createStripeClient } = require('./client');
const { loadStripeConfig } = require('./config');
const { createStripeRouter } = require('./router');

/**
 * The Stripe API, side by side with GHL and Kraken and independent from them: its own key,
 * limit and activity. Missing or wrong Stripe settings only disable /stripe.
 */
function createStripe({ env = process.env, ghlConfig, logger, others = [], clientOptions } = {}) {
  const config = loadStripeConfig(env, { ghl: ghlConfig, others });
  const client = createStripeClient(config, clientOptions);
  const metrics = createMetrics();
  const limiter = createRateLimiter({ max: ghlConfig.rateLimitMax, windowMs: ghlConfig.rateLimitWindowMs });
  const router = createStripeRouter({ config, client, logger, metrics, limiter });
  return {
    config,
    client,
    metrics,
    limiter,
    router,
    mountAdmin: (adminRouter, helpers) => mountStripeAdmin(adminRouter, { config, client, ghlConfig, metrics, logger, ...helpers }),
  };
}

/** For the entrypoints: never throws, so a Stripe problem can never take the rest down. */
function tryCreateStripe(options) {
  try {
    const stripe = createStripe(options);
    options.logger.info({ msg: 'stripe', enabled: stripe.config.enabled, mode: stripe.config.mode });
    return stripe;
  } catch (err) {
    options.logger.error({ msg: 'stripe_disabled', name: err && err.name });
    return null;
  }
}

module.exports = { createStripe, tryCreateStripe };
