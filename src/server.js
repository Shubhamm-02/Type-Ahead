/**
 * server.js — HTTP API that wires every component together.
 * =========================================================
 *
 * REQUEST FLOWS (the two important ones):
 *
 *  GET /suggest?q=ip   (read path — must be FAST)
 *    1. Ask the DISTRIBUTED CACHE for "ip". The consistent-hash ring picks the
 *       owning cache node.
 *    2. HIT  -> return the cached suggestions immediately. (no trie, no DB)
 *       MISS -> compute suggestions from the TRIE, store them in the cache
 *               (cache-aside), then return them.
 *
 *  POST /search {q: "iphone"}   (write path — must be CHEAP)
 *    1. Add the increment to the WRITE BUFFER (do NOT touch the DB yet).
 *    2. Return {"message":"Searched"} right away.
 *    3. Later, on flush (size or time trigger), the batch is applied to the
 *       STORE, the TRIE counts are updated, TRENDING heat is added, and the
 *       cache entries for affected prefixes are invalidated so suggestions and
 *       trending reflect the new counts.
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Trie } from './trie.js';
import { QueryStore } from './store.js';
import { DistributedCache } from './cache.js';
import { WriteBuffer } from './writeBuffer.js';
import { TrendingTracker } from './trending.js';
import { Metrics, timingMiddleware } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DATASET = path.join(DATA_DIR, 'queries.csv');
const SNAPSHOT = path.join(DATA_DIR, 'snapshot.csv');

// --- Configuration (tweak to see the effects in /metrics) ----------------
const CONFIG = {
  cacheNodes: 3,
  cacheTtlMs: 60_000,       // suggestions cached for 60s (safety net)
  virtualNodes: 150,        // ring points per cache node
  maxBatchSize: 500,        // flush after 500 distinct queries buffered
  flushIntervalMs: 2000,    // ...or every 2 seconds, whichever first
  trendingHalfLifeMs: 10 * 60_000, // trending heat halves every 10 minutes
  port: process.env.PORT || 3000,
};

// --- Build the components ------------------------------------------------
const store = new QueryStore();
const trie = new Trie();
const trending = new TrendingTracker({ halfLifeMs: CONFIG.trendingHalfLifeMs });
const cache = new DistributedCache({
  nodeCount: CONFIG.cacheNodes,
  ttlMs: CONFIG.cacheTtlMs,
  virtualNodes: CONFIG.virtualNodes,
});
const metrics = new Metrics();

/**
 * onFlush: the heart of the write path. Apply one batch atomically-ish:
 * DB -> trie -> trending -> cache invalidation.
 */
const writeBuffer = new WriteBuffer({
  maxBatchSize: CONFIG.maxBatchSize,
  flushIntervalMs: CONFIG.flushIntervalMs,
  onFlush: (deltas) => {
    const touched = store.applyBatch(deltas);          // 1) durable counts
    const affectedPrefixes = new Set();
    for (let i = 0; i < touched.length; i++) {
      const query = touched[i];
      const delta = deltas[i][1];
      trie.increment(query, delta);                    // 2) refresh index + topK
      trending.record(query, delta);                   // 3) trending heat
      // 4) collect every prefix of this query so we can drop stale cache lines
      for (let L = 1; L <= query.length; L++) affectedPrefixes.add(query.slice(0, L));
    }
    for (const p of affectedPrefixes) cache.invalidate(p);
    console.log(`[flush] applied ${deltas.length} queries, invalidated ${affectedPrefixes.size} prefixes`);
  },
});

// --- Boot: load data, build index, seed trending -------------------------
function boot() {
  const source = QueryStore.exists(SNAPSHOT) ? SNAPSHOT : DATASET;
  console.log(`Loading dataset from ${path.basename(source)} ...`);
  const t0 = Date.now();
  const { unique } = store.loadCSV(source);
  // Materialize the in-memory serving index (the trie) from the primary store.
  // Layering on a cache miss is: cache -> trie index -> (durable) store. The
  // store stays the source of truth; the trie is rebuilt from it on every boot.
  for (const [query, count] of store.map) {
    trie.set(query, count);
    trending.seedTotals(query, count);
  }
  trie.buildTopK();
  console.log(`Loaded ${unique.toLocaleString()} queries, built trie in ${Date.now() - t0}ms`);
  writeBuffer.start();
}

// --- HTTP app ------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(timingMiddleware(metrics));
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * GET /suggest?q=<prefix>&rank=basic|enhanced — top 10 suggestions.
 *   basic    (default) -> sorted by overall count           (§7, 60%)
 *   enhanced           -> recency-aware re-rank of the pool  (§7, 20%)
 * Cache-aside read path. The cache stores the STABLE count-ranked candidate
 * pool (size SUGGEST_POOL); enhanced re-ranking runs LIVE on that pool, so
 * recency decay never makes the cache stale and no extra invalidation is needed.
 */
const SUGGEST_POOL = 20; // count-ranked candidates cached per prefix
app.get('/suggest', (req, res) => {
  const q = Trie.normalize(req.query.q || '');
  const rank = req.query.rank === 'enhanced' ? 'enhanced' : 'basic';
  if (!q) return res.json({ query: '', rank, source: 'empty', suggestions: [] });

  const cached = cache.get(q);
  let pool, source;
  if (cached.status === 'hit') {
    pool = cached.value;
    source = 'cache';
  } else {
    // MISS -> compute the count-ranked pool from the trie (the in-memory index
    // built from the primary store), then cache it. No disk/DB hit on reads.
    pool = trie.suggest(q, SUGGEST_POOL);
    cache.set(q, pool);
    source = 'trie';
  }

  const ranked = rank === 'enhanced' ? trending.rankByRecency(pool) : pool;
  res.json({ query: q, rank, source, node: cached.node, suggestions: ranked.slice(0, 10) });
});

/** POST /search {q} — buffer the increment, return immediately. */
app.post('/search', (req, res) => {
  const q = Trie.normalize((req.body && req.body.q) || '');
  if (!q) return res.status(400).json({ error: 'missing query "q"' });
  writeBuffer.add(q, 1); // batched; DB is NOT touched synchronously
  res.json({ message: 'Searched' });
});

/** GET /cache/debug?prefix=<p> — which node owns it + hit/miss + ring spread. */
app.get('/cache/debug', (req, res) => {
  const prefix = Trie.normalize(req.query.prefix || '');
  if (!prefix) return res.status(400).json({ error: 'missing "prefix"' });
  res.json(cache.debug(prefix));
});

/** GET /trending?mode=enhanced|basic — recency-aware or all-time leaderboard. */
app.get('/trending', (req, res) => {
  const mode = req.query.mode === 'basic' ? 'basic' : 'enhanced';
  const list = mode === 'basic' ? trending.topByTotal(10) : trending.topTrending(10);
  res.json({ mode, trending: list });
});

/** GET /metrics — the live performance report (p95, hit rate, DB load, ...). */
app.get('/metrics', (req, res) => {
  res.json({
    config: CONFIG,
    dataset: { uniqueQueries: store.size, trieSize: trie.size },
    latencyMs: metrics.latencySummary(),
    cache: cache.stats(),
    db: { reads: store.reads, writes: store.writes },
    writeBuffer: writeBuffer.stats(),
    consistentHashing: {
      ringPoints: cache.ring.ring.length,
      distribution: cache.ring.distribution(),
      log: cache.ring.log.slice(-20), // recent ring changes
    },
  });
});

/** POST /admin/flush — force a buffer flush (handy for demos/tests). */
app.post('/admin/flush', (req, res) => res.json(writeBuffer.flush('manual')));

/** POST /admin/cache-node {action:'add'|'remove', id} — show ring elasticity. */
app.post('/admin/cache-node', (req, res) => {
  const { action, id } = req.body || {};
  if (action === 'add') cache.addCacheNode(id);
  else if (action === 'remove') cache.removeCacheNode(id);
  else return res.status(400).json({ error: "action must be 'add' or 'remove'" });
  res.json({ ok: true, nodes: cache.nodeIds, distribution: cache.ring.distribution() });
});

/** POST /admin/snapshot — persist current counts so a restart keeps them. */
app.post('/admin/snapshot', (req, res) => {
  writeBuffer.flush('snapshot');
  store.saveSnapshot(SNAPSHOT);
  res.json({ ok: true, savedTo: 'data/snapshot.csv', queries: store.size });
});

// Graceful shutdown: flush buffered writes so we don't lose them on Ctrl-C.
function shutdown() {
  console.log('\nShutting down: flushing write buffer...');
  writeBuffer.flush('shutdown');
  writeBuffer.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Export for tests; only listen when run directly.
boot();
const server = app.listen(CONFIG.port, () => {
  console.log(`\n  Search typeahead running:  http://localhost:${CONFIG.port}`);
  console.log(`  Try:  curl 'http://localhost:${CONFIG.port}/suggest?q=ip'\n`);
});

export { app, server, store, trie, cache, writeBuffer, trending, metrics };
