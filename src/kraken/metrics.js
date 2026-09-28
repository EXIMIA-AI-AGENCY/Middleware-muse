'use strict';

const MAX_RECENT = 25;

/**
 * Kraken activity for the panel, kept apart from the GoHighLevel metrics. Stores the method
 * name, status, Kraken's first error string and timings; never keys, params or results.
 */
function createKrakenMetrics({ now = () => Date.now() } = {}) {
  const recent = [];
  const counters = { calls: 0, ok: 0, krakenErrors: 0, rejectedKey: 0, rejectedMethod: 0, rateLimited: 0, upstreamErrors: 0 };
  const round = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : null);

  return {
    record({ check = false, status, method = null, error = null, explain = null, executed = null, krakenMs = null, totalMs = null, attempts = null, rejectedKey, rateLimited, upstreamError }) {
      if (check) return; // the panel's own tests are not Muse's activity
      if (rejectedKey) counters.rejectedKey += 1;
      if (rateLimited) counters.rateLimited += 1;
      if (rejectedKey || rateLimited) return;
      counters.calls += 1;
      if (upstreamError) counters.upstreamErrors += 1;
      else if (status === 403 || status === 400) counters.rejectedMethod += 1;
      else if (error) counters.krakenErrors += 1;
      else if (status === 200) counters.ok += 1;
      recent.push({
        at: now(),
        method,
        status,
        error,
        explain: explain ? String(explain).slice(0, 240) : null,
        executed: executed || null,
        krakenMs: round(krakenMs),
        totalMs: round(totalMs),
        attempts,
      });
      if (recent.length > MAX_RECENT) recent.shift();
    },
    snapshot() {
      return { ...counters, recent: [...recent].reverse() };
    },
  };
}

module.exports = { createKrakenMetrics };
