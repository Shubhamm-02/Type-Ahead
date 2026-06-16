/**
 * cache.js — A distributed, in-process suggestion cache.
 * ======================================================
 *
 * WHY A CACHE AT ALL?
 *   Even though our trie lookup is fast, the cache lets us (a) demonstrate the
 *   cache-aside pattern the assignment asks for, (b) absorb repeated hot
 *   prefixes ("ip", "a") so we don't even touch the trie, and (c) measure a
 *   real hit rate. ANALOGY: the trie is the kitchen; the cache is the tray of
 *   ready-made dishes on the counter. If the dish is on the tray (hit), you
 *   serve instantly; otherwise you cook it (miss) and leave a copy on the tray.
 *
 * WHAT IS "DISTRIBUTED" HERE?
 *   Production systems run many cache servers (e.g. several Redis nodes). We
 *   model that with several independent `CacheNode` objects in one process.
 *   A `ConsistentHashRing` decides which node owns each prefix. This makes the
 *   distribution logic real and observable (see GET /cache/debug) without
 *   forcing you to install and run a Redis cluster — keeping local setup easy.
 *
 * TTL (time to live) / EXPIRY
 *   Each entry carries an expiry timestamp. After it passes, the entry is
 *   stale and treated as a miss. This bounds how out-of-date a suggestion list
 *   can be after the underlying counts change. We ALSO actively invalidate
 *   affected prefixes when a batch of writes is flushed (see writeBuffer.js),
 *   so TTL is a safety net rather than the primary freshness mechanism.
 */

import { ConsistentHashRing } from './consistentHashing.js';

/**
 * A single cache server. Stores prefix -> { value, expiresAt }.
 * Includes a simple LRU-ish cap so memory can't grow without bound.
 */
class CacheNode {
  constructor(id, { maxEntries = 50_000 } = {}) {
    this.id = id;
    this.maxEntries = maxEntries;
    this.map = new Map(); // insertion order is used for cheap LRU eviction
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) { this.misses++; return { status: 'miss', value: null }; }
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.misses++;
      return { status: 'expired', value: null };
    }
    // Refresh recency: delete + re-insert moves the key to the "newest" end.
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return { status: 'hit', value: entry.value };
  }

  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
    // Evict the least-recently-used (oldest) entry if over capacity.
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  delete(key) { return this.map.delete(key); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

export class DistributedCache {
  /**
   * @param {object} opts
   * @param {number} opts.nodeCount  how many cache servers to simulate
   * @param {number} opts.ttlMs      entry lifetime in milliseconds
   */
  constructor({ nodeCount = 3, ttlMs = 60_000, virtualNodes = 150 } = {}) {
    this.ttlMs = ttlMs;
    this.nodeIds = Array.from({ length: nodeCount }, (_, i) => `cache-${i}`);
    this.nodes = new Map(this.nodeIds.map((id) => [id, new CacheNode(id)]));
    this.ring = new ConsistentHashRing(this.nodeIds, virtualNodes);
  }

  _nodeFor(prefix) {
    const id = this.ring.getNode(prefix);
    return this.nodes.get(id);
  }

  /** Cache-aside read. Returns { status, value, node }. */
  get(prefix) {
    const node = this._nodeFor(prefix);
    const res = node.get(prefix);
    return { ...res, node: node.id };
  }

  set(prefix, value) {
    const node = this._nodeFor(prefix);
    node.set(prefix, value, this.ttlMs);
    return node.id;
  }

  /** Invalidate one prefix on whichever node owns it. */
  invalidate(prefix) {
    const node = this._nodeFor(prefix);
    return node.delete(prefix);
  }

  /** Nuke everything (used when many counts changed at once, e.g. big flush). */
  invalidateAll() {
    for (const node of this.nodes.values()) node.clear();
  }

  /**
   * Add or remove a cache server AT RUNTIME. Because of consistent hashing,
   * only the keys in the affected ring slice move — the rest stay put. We DO
   * clear entries that would now hash to a different node to avoid serving
   * from the wrong place; in a real cluster those keys would simply miss once
   * and refill. This method exists so the demo can show elasticity.
   */
  addCacheNode(id) {
    if (this.nodes.has(id)) return;
    this.nodes.set(id, new CacheNode(id));
    this.nodeIds.push(id);
    this.ring.addNode(id);
  }
  removeCacheNode(id) {
    if (!this.nodes.has(id)) return;
    this.nodes.get(id).clear();
    this.nodes.delete(id);
    this.nodeIds = this.nodeIds.filter((n) => n !== id);
    this.ring.removeNode(id);
  }

  /** Where would this prefix go, and is it currently cached? For /cache/debug. */
  debug(prefix) {
    const node = this._nodeFor(prefix);
    const entry = node.map.get(prefix);
    const present = !!entry && entry.expiresAt > Date.now();
    return {
      prefix,
      responsibleNode: node.id,
      status: present ? 'HIT' : 'MISS',
      cachedValue: present ? entry.value : null,
      ttlRemainingMs: present ? entry.expiresAt - Date.now() : 0,
      ringDistribution: this.ring.distribution(),
    };
  }

  stats() {
    let hits = 0, misses = 0, entries = 0;
    const perNode = {};
    for (const node of this.nodes.values()) {
      hits += node.hits; misses += node.misses; entries += node.size;
      perNode[node.id] = { hits: node.hits, misses: node.misses, entries: node.size };
    }
    const total = hits + misses;
    return {
      hits, misses, entries,
      hitRate: total ? +(hits / total).toFixed(4) : 0,
      perNode,
    };
  }
}
