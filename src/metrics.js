'use strict';

const { loggablePath } = require('./logger');

const MAX_SAMPLES = 2000;
const MAX_CHECK_SAMPLES = 50;
const RECENT = 25;
const WINDOW_MS = 15 * 60 * 1000;

const ms = (from, to) => Number(to - from) / 1e6;

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function stats(values) {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return { p50: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)) };
}

function summarize(samples) {
  return {
    count: samples.length,
    totalMs: stats(samples.map((s) => s.totalMs)),
    ghlMs: stats(samples.map((s) => s.ghlMs)),
    overheadMs: stats(samples.map((s) => s.overheadMs)),
  };
}

function pushBounded(list, item, max) {
  list.push(item);
  if (list.length > max) list.splice(0, list.length - max);
}

/**
 * In-memory metrics for the admin dashboard. Records only what the access log records
 * (method, path without query, status, timings) — never headers or bodies.
 *
 * - Muse's proxied calls (/ghl, /mcp) feed the traffic stats and "recent" list.
 * - The dashboard's own test calls (`check`) are kept apart so they never hide Muse's calls.
 * - Rejections are counted by cause: bad proxy key, bad PIN, rate limit; GHL's own 401/403
 *   (e.g. a missing scope) are counted separately, since they are not intrusion attempts.
 */
function createMetrics({ now = () => Date.now() } = {}) {
  const traffic = [];
  const checks = [];
  const counters = {
    calls: 0,
    '2xx': 0,
    '3xx': 0,
    '4xx': 0,
    '5xx': 0,
    rejectedKey: 0,
    rejectedPin: 0,
    rateLimited: 0,
    ghlDenied: 0,
    upstreamErrors: 0,
  };
  const startedAt = now();

  return {
    startedAt,

    /** Called once per request when the response closes. */
    record({ method, url, status, timing, check = false, flags = {} }) {
      if (flags.rejectedPin) counters.rejectedPin += 1;
      if (check) {
        if (timing) {
          pushBounded(checks, sample(method, url, status, timing), MAX_CHECK_SAMPLES);
        }
        return;
      }
      if (flags.rejectedKey) counters.rejectedKey += 1;
      if (flags.rateLimited) counters.rateLimited += 1;
      if (!timing) return; // /health, /admin and the rejections above are not Muse calls
      counters.calls += 1;
      const bucket = `${Math.floor(status / 100)}xx`;
      if (bucket in counters) counters[bucket] += 1;
      if (timing.upstreamError) counters.upstreamErrors += 1;
      else if (status === 401 || status === 403) counters.ghlDenied += 1;
      pushBounded(traffic, sample(method, url, status, timing), MAX_SAMPLES);
    },

    snapshot() {
      const cutoff = now() - WINDOW_MS;
      return {
        ...counters,
        last15m: summarize(traffic.filter((s) => s.at >= cutoff)),
        checks: summarize(checks.filter((s) => s.at >= cutoff)),
        recent: traffic.slice(-RECENT).reverse(),
      };
    },
  };

  function sample(method, url, status, timing) {
    return {
      at: now(),
      method,
      path: loggablePath(url),
      status,
      totalMs: Math.round(timing.totalMs * 10) / 10,
      ghlMs: timing.ghlMs === null ? null : Math.round(timing.ghlMs * 10) / 10,
      overheadMs: timing.overheadMs === null ? null : Math.round(timing.overheadMs * 100) / 100,
    };
  }
}

/**
 * Per-request timing for proxied calls. `ghlMs` is the time GHL took to start answering
 * (request sent -> response headers); `overheadMs` is the proxy's own processing
 * (arrival -> request sent, plus response headers -> headers relayed).
 */
function createTiming(startedAt) {
  const marks = { start: startedAt ?? process.hrtime.bigint(), sent: null, upstreamHeaders: null, relayed: null };
  return {
    sent() {
      marks.sent = process.hrtime.bigint();
    },
    upstreamHeaders() {
      marks.upstreamHeaders = process.hrtime.bigint();
    },
    relayed() {
      marks.relayed = process.hrtime.bigint();
    },
    result(upstreamError) {
      const end = process.hrtime.bigint();
      const complete = marks.sent && marks.upstreamHeaders && marks.relayed;
      return {
        totalMs: ms(marks.start, end),
        ghlMs: marks.sent && marks.upstreamHeaders ? ms(marks.sent, marks.upstreamHeaders) : null,
        overheadMs: complete ? ms(marks.start, marks.sent) + ms(marks.upstreamHeaders, marks.relayed) : null,
        upstreamError: Boolean(upstreamError),
      };
    },
  };
}

module.exports = { createMetrics, createTiming, stats };
