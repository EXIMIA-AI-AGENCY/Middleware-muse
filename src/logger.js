'use strict';

const MAX_PATH_LENGTH = 256;

/**
 * JSON-lines logger. Callers only ever pass the fields they want logged; there is
 * deliberately no helper that accepts a request or headers object.
 */
function createLogger(stream = process.stdout) {
  const write = (level, fields) => {
    stream.write(`${JSON.stringify({ ts: new Date().toISOString(), level, ...fields })}\n`);
  };
  return {
    info: (fields) => write('info', fields),
    warn: (fields) => write('warn', fields),
    error: (fields) => write('error', fields),
  };
}

/** Path without the query string: queries can carry PII (emails, phones, search terms). */
function loggablePath(url) {
  const path = String(url ?? '').split('?', 1)[0];
  return path.length > MAX_PATH_LENGTH ? `${path.slice(0, MAX_PATH_LENGTH)}…` : path;
}

/** Access log: method, path, status and latency only. Optionally feeds the dashboard metrics. */
function requestLogger(logger, metrics, isCheck = () => false) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.locals.startedAt = start;
    res.once('close', () => {
      const fields = {
        method: req.method,
        path: loggablePath(req.originalUrl),
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
      };
      if (!res.writableFinished) fields.aborted = true;
      logger.info(fields);
      // A route with its own activity (the agency API) sets res.locals.metrics.
      const target = res.locals.metrics || metrics;
      if (target) {
        const { timing, upstreamError, rejectedKey, rejectedPin, rateLimited, blocked } = res.locals;
        target.record({
          method: req.method,
          url: req.originalUrl,
          // Client gave up before any answer: not a success, whatever res.statusCode says.
          status: res.headersSent ? res.statusCode : 499,
          timing: timing && timing.result(upstreamError),
          check: isCheck(req, res),
          flags: { rejectedKey, rejectedPin, rateLimited, blocked },
        });
      }
    });
    next();
  };
}

module.exports = { createLogger, requestLogger, loggablePath };
