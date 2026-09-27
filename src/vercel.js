'use strict';

// Vercel entrypoint: Vercel runs the exported Express app as a function (no listen()).
// Docker/VPS/Railway use src/server.js instead.
const { createApp } = require('./create-app');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');

const logger = createLogger();

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  // Same rule as the server: no GHL_TOKEN / PROXY_KEY, no service. Never log values.
  logger.error({ msg: 'startup_failed', reason: err.message });
  throw err;
}

const app = createApp(config, logger);
// The dashboard tests the proxy through its public production URL, exactly like Muse.
const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
if (productionHost) app.locals.selfUrl = `https://${productionHost}`;

module.exports = app;
