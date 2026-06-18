/**
 * metrics.js — Observability: latency percentiles and counters.
 * =============================================================
 *
 * The assignment requires a performance report with p95 latency, cache hit
 * rate, and DB read/write counts. This module collects per-endpoint latency
 * samples and computes percentiles on demand.
 *
 * WHY p95 (95th percentile) AND NOT THE AVERAGE?
 *   Averages hide pain. If 95 requests take 1ms and 5 take 900ms, the average
 *   (~46ms) looks fine while 1 in 20 users waits almost a second. p95 = "95%
 *   of requests are at least this fast" — it captures the experience of your
 *   UNLUCKY users, which is what actually drives complaints. ANALOGY: a bus
 *   that's "on average" on time can still strand you every Friday; the 95th-
 *   percentile delay tells you about the bad days.
 */

export class Metrics {
  constructor({ window = 2000 } = {}) {
    this.window = window;            // keep the last N samples per route
    this.latencies = new Map();      // route -> number[] (ms)
  }

  /** Record one request's latency for a route (e.g. 'GET /suggest'). */
  record(route, ms) {
    let arr = this.latencies.get(route);
    if (!arr) { arr = []; this.latencies.set(route, arr); }
    arr.push(ms);
    if (arr.length > this.window) arr.shift(); // ring-ish buffer
  }

  _percentile(sortedArr, p) {
    if (sortedArr.length === 0) return 0;
    const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
    return sortedArr[idx];
  }

  /** Latency summary per route: count, p50, p95, p99, max (all ms). */
  latencySummary() {
    const out = {};
    for (const [route, arr] of this.latencies) {
      const sorted = [...arr].sort((a, b) => a - b);
      out[route] = {
        count: sorted.length,
        p50: +this._percentile(sorted, 50).toFixed(3),
        p95: +this._percentile(sorted, 95).toFixed(3),
        p99: +this._percentile(sorted, 99).toFixed(3),
        max: +(sorted[sorted.length - 1] || 0).toFixed(3),
      };
    }
    return out;
  }
}

/** Express middleware factory: times every request and records it by route. */
export function timingMiddleware(metrics) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      // Use the matched route path when available so query strings don't split
      // the same endpoint into many buckets.
      const route = `${req.method} ${req.route ? req.baseUrl + req.route.path : req.path}`;
      metrics.record(route, ms);
    });
    next();
  };
}
