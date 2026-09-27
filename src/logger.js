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

/** Access log: method, path, status and latency only. */
function requestLogger(logger) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.once('close', () => {
      const fields = {
        method: req.method,
        path: loggablePath(req.originalUrl),
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
      };
      if (!res.writableFinished) fields.aborted = true;
      logger.info(fields);
    });
    next();
  };
}

module.exports = { createLogger, requestLogger, loggablePath };
