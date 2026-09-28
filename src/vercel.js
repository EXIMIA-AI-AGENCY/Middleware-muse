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

// Optional and isolated: without Kraken settings, with wrong ones, or even if the Kraken code
// failed to load, GHL runs exactly as before.
function loadKraken() {
  try {
    return require('./kraken').tryCreateKraken({ env: process.env, ghlConfig: config, logger });
  } catch (err) {
    logger.error({ msg: 'kraken_disabled', name: err && err.name });
    return null;
  }
}
const kraken = loadKraken();
// Same rule for the GHL agency API: optional, isolated, never takes the rest down.
function loadAgency() {
  try {
    const others = kraken && kraken.config.accessKey ? [kraken.config.accessKey] : [];
    return require('./agency').tryCreateAgency({ env: process.env, ghlConfig: config, logger, others });
  } catch (err) {
    logger.error({ msg: 'ghl_agency_disabled', name: err && err.name });
    return null;
  }
}
const agency = loadAgency();
const app = createApp(config, logger, { kraken, agency });
// The dashboard tests the proxy through its public production URL, exactly like Muse.
const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
if (productionHost) app.locals.selfUrl = `https://${productionHost}`;

module.exports = app;
