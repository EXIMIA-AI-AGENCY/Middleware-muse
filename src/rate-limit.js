'use strict';

const { sendJson } = require('./http-util');

/**
 * In-memory sliding-window limiter: at most `max` hits per `windowMs` per id.
 * State is per process, which is fine for a single-instance deployment.
 */
function createRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map(); // id -> ascending timestamps inside the current window

  const prune = (list, t) => {
    let i = 0;
    while (i < list.length && list[i] <= t - windowMs) i++;
    if (i > 0) list.splice(0, i);
  };

  // Drop idle ids so the map cannot grow without bound.
  const sweeper = setInterval(() => {
    const t = now();
    for (const [id, list] of hits) {
      prune(list, t);
      if (list.length === 0) hits.delete(id);
    }
  }, Math.max(windowMs, 1000));
  sweeper.unref();

  return {
    hit(id) {
      const t = now();
      let list = hits.get(id);
      if (!list) {
        list = [];
        hits.set(id, list);
      }
      prune(list, t);
      if (list.length >= max) {
        return { allowed: false, retryAfterMs: list[0] + windowMs - t };
      }
      list.push(t);
      return { allowed: true, retryAfterMs: 0 };
    },
    stop() {
      clearInterval(sweeper);
    },
  };
}

/**
 * Limits authenticated traffic per proxy key. There is a single key, so this is
 * effectively the budget for all of Muse's automations together.
 */
function rateLimitByKey(limiter) {
  return (req, res, next) => {
    // The dashboard's marked test calls never eat into Muse's budget.
    if (res.locals.check) return next();
    // Runs after requireProxyKey, so the header is the valid key; one bucket for it.
    const { allowed, retryAfterMs } = limiter.hit('proxy-key');
    if (allowed) return next();
    res.locals.rateLimited = true;
    return sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) });
  };
}

module.exports = { createRateLimiter, rateLimitByKey };
