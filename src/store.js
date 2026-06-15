/**
 * store.js — The durable query-count store ("the database").
 * ==========================================================
 *
 * ROLE
 *   This is our source of truth: the authoritative count for every query.
 *   In a real system this would be PostgreSQL / DynamoDB / Redis-with-AOF.
 *   Here it is an in-memory Map loaded from the CSV, with optional snapshot
 *   persistence to disk so restarts keep accumulated counts. Keeping it
 *   in-process means zero database setup — a grading requirement ("easy local
 *   setup") — while still letting us model DB reads/writes and batching.
 *
 * WHY SEPARATE FROM THE TRIE?
 *   The trie is a derived INDEX optimized for prefix lookups. The store is the
 *   FLAT TRUTH (query -> count). Separating them mirrors real systems: the
 *   database holds the data; a search index (trie / Elasticsearch) is built
 *   from it for fast queries. We count reads/writes here to report DB load.
 */

import fs from 'node:fs';
import path from 'node:path';

export class QueryStore {
  constructor() {
    this.map = new Map(); // query -> count
    this.reads = 0;       // metric: logical DB reads
    this.writes = 0;      // metric: logical DB writes (rows updated)
  }

  /** Load "query,count" CSV. Aggregates duplicates (derive counts via sum). */
  loadCSV(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const lines = text.split('\n');
    let loaded = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (i === 0 && /^query\s*,\s*count$/i.test(line)) continue; // header
      const idx = line.lastIndexOf(',');
      if (idx === -1) continue;
      const query = line.slice(0, idx).toLowerCase().trim().replace(/\s+/g, ' ');
      const count = parseInt(line.slice(idx + 1), 10);
      if (!query || Number.isNaN(count)) continue;
      // Aggregate: if the dataset lists a query twice, sum the counts.
      this.map.set(query, (this.map.get(query) || 0) + count);
      loaded++;
    }
    return { rows: loaded, unique: this.map.size };
  }

  get(query) { this.reads++; return this.map.get(query) ?? 0; }
  has(query) { return this.map.has(query); }

  /**
   * Apply a batch of aggregated deltas: query -> amount-to-add.
   * Returns the list of queries that were touched so the caller can refresh
   * the trie and invalidate caches for exactly those. Each touched query is
   * ONE logical DB write — the whole point of batching (see writeBuffer.js).
   */
  applyBatch(deltas) {
    const touched = [];
    for (const [query, delta] of deltas) {
      this.map.set(query, (this.map.get(query) || 0) + delta);
      this.writes++;
      touched.push(query);
    }
    return touched;
  }

  get size() { return this.map.size; }

  /** Persist a snapshot so accumulated counts survive a restart. */
  saveSnapshot(filePath) {
    const tmp = filePath + '.tmp';
    const out = ['query,count'];
    for (const [q, c] of this.map) out.push(`${q},${c}`);
    fs.writeFileSync(tmp, out.join('\n') + '\n');
    fs.renameSync(tmp, filePath); // atomic-ish replace
  }

  static exists(filePath) { return fs.existsSync(path.resolve(filePath)); }
}
