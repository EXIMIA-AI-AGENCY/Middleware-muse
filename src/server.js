'use strict';

const http = require('node:http');
const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');

const logger = createLogger();

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  // ConfigError messages name the variable, never its value.
  logger.error({ msg: 'startup_failed', reason: err.message });
  process.exit(1);
}

const app = createApp(config, logger);
const server = http.createServer(app);
// Outlive the idle timeout of platform load balancers (typically 60 s) to avoid spurious 502s.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

server.listen(config.port, () => {
  logger.info({
    msg: 'listening',
    port: config.port,
    version: config.version,
    upstream: config.upstreamBase.origin,
    rateLimit: `${config.rateLimitMax}/${config.rateLimitWindowMs}ms`,
  });
});

server.on('error', (err) => {
  logger.error({ msg: 'server_error', code: err.code });
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ msg: 'shutting_down', signal });
  app.locals.limiter.stop();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  // Long-lived MCP streams must not block a redeploy forever.
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error({ msg: 'uncaught_exception', name: err && err.name, code: err && err.code });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  logger.error({ msg: 'unhandled_rejection', name: err && err.name, code: err && err.code });
});
