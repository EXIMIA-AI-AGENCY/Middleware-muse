'use strict';

const { loggablePath } = require('./logger');

const MAX_SAMPLES = 2000;
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

/**
 * In-memory request metrics for the admin dashboard. Records only what the access
 * log records (method, path without query, status, timings) — never headers or bodies.
 */
function createMetrics({ now = () => Date.now() } = {}) {
  const samples = []; // ring buffer of proxied (/ghl, /mcp) requests
  const counters = { total: 0, unauthorized: 0, rateLimited: 0, upstreamErrors: 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  const startedAt = now();

  return {
    startedAt,

    /** Called once per request when the response closes. `check` marks the dashboard's own test calls. */
    record({ method, url, status, timing, check = false }) {
      // The dashboard's deliberate "no key" test is not an intrusion attempt.
      if (check && status === 401) return;
      counters.total += 1;
      const bucket = `${Math.floor(status / 100)}xx`;
      if (bucket in counters) counters[bucket] += 1;
      if (status === 401) counters.unauthorized += 1;
      if (status === 429) counters.rateLimited += 1;
      if (!timing) return;
      if (timing.upstreamError) counters.upstreamErrors += 1;
      samples.push({
        at: now(),
        method,
        path: loggablePath(url),
        status,
        totalMs: Math.round(timing.totalMs * 10) / 10,
        ghlMs: timing.ghlMs === null ? null : Math.round(timing.ghlMs * 10) / 10,
        overheadMs: timing.overheadMs === null ? null : Math.round(timing.overheadMs * 100) / 100,
        check,
      });
      if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    },

    snapshot() {
      const cutoff = now() - WINDOW_MS;
      const recentWindow = samples.filter((s) => s.at >= cutoff);
      return {
        ...counters,
        last15m: {
          count: recentWindow.length,
          totalMs: stats(recentWindow.map((s) => s.totalMs)),
          ghlMs: stats(recentWindow.map((s) => s.ghlMs)),
          overheadMs: stats(recentWindow.map((s) => s.overheadMs)),
        },
        recent: samples.slice(-RECENT).reverse(),
      };
    },
  };
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
