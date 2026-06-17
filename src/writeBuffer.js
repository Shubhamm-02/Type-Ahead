/**
 * writeBuffer.js — Batching writes to cut database load.
 * ======================================================
 *
 * THE PROBLEM
 *   Every POST /search wants to do `count = count + 1` in the database.
 *   At high traffic that's a flood of tiny writes. Databases hate many small
 *   writes (each has fixed overhead: locks, disk flush, index update).
 *
 * THE IDEA: AGGREGATE, THEN FLUSH
 *   ANALOGY: a courier doesn't drive to the post office for each letter. They
 *   collect letters in a mailbag all morning and make ONE trip. We collect
 *   increments in an in-memory buffer and write them in one batch.
 *
 *   Crucially we also AGGREGATE: if "iphone" is searched 50 times before a
 *   flush, the buffer holds a single entry {iphone: +50}. The database does
 *   ONE write of +50 instead of 50 writes of +1. Repeated hot queries get the
 *   biggest savings.
 *
 * WHEN DO WE FLUSH?
 *   Two triggers, whichever comes first:
 *     1. SIZE   — buffer reaches `maxBatchSize` distinct queries (burst guard).
 *     2. TIME   — every `flushIntervalMs` (latency guard, so quiet traffic
 *                 still lands within a bounded delay).
 *
 * THE TRADE-OFF (must discuss): DATA LOSS RISK
 *   Buffered increments live in memory. If the process crashes before a flush,
 *   those increments are LOST. We accept this because:
 *     - the data is approximate popularity counts, not money — losing a few
 *       seconds of increments barely changes rankings; and
 *     - the window is bounded by `flushIntervalMs` (here ~2s).
 *   If we needed durability we would first append each increment to a
 *   write-ahead log (WAL) on disk, then batch into the DB — trading a little
 *   latency for crash safety. We note this explicitly rather than pretending
 *   the risk doesn't exist.
 */

export class WriteBuffer {
  /**
   * @param {object}   opts
   * @param {number}   opts.maxBatchSize     flush after this many distinct queries
   * @param {number}   opts.flushIntervalMs  flush at least this often
   * @param {Function} opts.onFlush          (deltasArray) => void, applies the batch
   */
  constructor({ maxBatchSize = 500, flushIntervalMs = 2000, onFlush }) {
    this.maxBatchSize = maxBatchSize;
    this.flushIntervalMs = flushIntervalMs;
    this.onFlush = onFlush;
    this.buffer = new Map(); // query -> accumulated delta
    this.timer = null;

    // Metrics that let us prove the write reduction in the performance report.
    this.totalSearchesBuffered = 0; // raw increments received
    this.totalFlushes = 0;
    this.totalRowsFlushed = 0;      // distinct queries written across all flushes
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush('interval'), this.flushIntervalMs);
    // Don't keep the event loop alive solely for this timer.
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Record one search. Aggregates with any pending delta for the same query. */
  add(rawQuery, delta = 1) {
    const query = String(rawQuery).toLowerCase().trim().replace(/\s+/g, ' ');
    if (!query) return;
    this.buffer.set(query, (this.buffer.get(query) || 0) + delta);
    this.totalSearchesBuffered += delta;
    // SIZE trigger: too many distinct queries pending -> flush now.
    if (this.buffer.size >= this.maxBatchSize) this.flush('size');
  }

  /** Push the buffered, aggregated deltas downstream and clear the buffer. */
  flush(reason = 'manual') {
    if (this.buffer.size === 0) return { flushed: 0, reason };
    const deltas = [...this.buffer.entries()]; // [ [query, delta], ... ]
    this.buffer = new Map();
    this.totalFlushes++;
    this.totalRowsFlushed += deltas.length;
    this.onFlush(deltas, reason);
    return { flushed: deltas.length, reason };
  }

  stats() {
    // writeReductionRatio = raw increments / actual DB writes. Higher is better.
    const ratio = this.totalRowsFlushed
      ? +(this.totalSearchesBuffered / this.totalRowsFlushed).toFixed(2)
      : 1;
    return {
      pending: this.buffer.size,
      totalSearchesBuffered: this.totalSearchesBuffered,
      totalFlushes: this.totalFlushes,
      totalRowsFlushed: this.totalRowsFlushed,
      writeReductionRatio: ratio, // e.g. 8.0 => 8x fewer DB writes than naive
      maxBatchSize: this.maxBatchSize,
      flushIntervalMs: this.flushIntervalMs,
    };
  }
}
