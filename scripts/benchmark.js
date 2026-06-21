/**
 * benchmark.js — Drives load against a RUNNING server and prints a report.
 * ========================================================================
 * Produces the numbers the assignment asks for: p95 latency, cache hit rate,
 * DB reads/writes, and the batch write-reduction ratio.
 *
 * Usage:  node src/server.js          (in one terminal)
 *         node scripts/benchmark.js   (in another)
 *
 * It fires a realistic mix:
 *   - many /suggest reads over popular prefixes (so the cache can warm up)
 *   - a stream of /search writes (so batching + trending have data)
 */

const BASE = process.env.BASE || 'http://localhost:3000';
const PREFIXES = ['a', 'ip', 'iph', 'sam', 'java', 'pyt', 'piz', 'lap', 'goo', 'son',
  'dell', 'nik', 'bo', 'gam', 'ssd', 'mon', 'key', 'rou', 'cam', 'wat'];
const SEARCHES = ['iphone', 'iphone 15', 'java tutorial', 'pizza near me',
  'samsung galaxy', 'python course', 'laptop deals', 'sony headphones',
  'gaming mouse', 'iphone', 'iphone', 'java tutorial', 'iphone 15 pro'];

const SUGGEST_REQUESTS = 5000;
const SEARCH_REQUESTS = 3000;

const pick = (arr, i) => arr[i % arr.length];

async function main() {
  console.log(`Benchmarking ${BASE} ...`);

  // 1) Read load — repeated hot prefixes drive a high cache hit rate.
  const t0 = Date.now();
  for (let i = 0; i < SUGGEST_REQUESTS; i++) {
    await fetch(`${BASE}/suggest?q=${encodeURIComponent(pick(PREFIXES, i))}`);
  }
  const readMs = Date.now() - t0;

  // 2) Write load — repeated queries demonstrate batch aggregation savings.
  const t1 = Date.now();
  for (let i = 0; i < SEARCH_REQUESTS; i++) {
    await fetch(`${BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: pick(SEARCHES, i) }),
    });
  }
  const writeMs = Date.now() - t1;

  // Force any remaining buffered writes to land before reading metrics.
  await fetch(`${BASE}/admin/flush`, { method: 'POST' });
  await new Promise((r) => setTimeout(r, 200));

  const m = await (await fetch(`${BASE}/metrics`)).json();

  console.log('\n================ PERFORMANCE REPORT ================');
  console.log(`Suggest: ${SUGGEST_REQUESTS} reqs in ${readMs}ms (${(SUGGEST_REQUESTS / readMs * 1000).toFixed(0)} req/s)`);
  console.log(`Search:  ${SEARCH_REQUESTS} reqs in ${writeMs}ms (${(SEARCH_REQUESTS / writeMs * 1000).toFixed(0)} req/s)`);
  console.log('\nLatency (ms):');
  for (const [route, l] of Object.entries(m.latencyMs)) {
    console.log(`  ${route.padEnd(22)} p50=${l.p50}  p95=${l.p95}  p99=${l.p99}  max=${l.max}  (n=${l.count})`);
  }
  console.log('\nCache:');
  console.log(`  hit rate: ${(m.cache.hitRate * 100).toFixed(1)}%  (hits=${m.cache.hits}, misses=${m.cache.misses})`);
  console.log(`  per node: ${JSON.stringify(m.cache.perNode)}`);
  console.log('\nDatabase:');
  console.log(`  reads=${m.db.reads}  writes=${m.db.writes}`);
  console.log('\nBatch writes:');
  const wb = m.writeBuffer;
  console.log(`  raw searches buffered: ${wb.totalSearchesBuffered}`);
  console.log(`  actual DB rows written: ${wb.totalRowsFlushed} across ${wb.totalFlushes} flushes`);
  console.log(`  write reduction ratio: ${wb.writeReductionRatio}x fewer writes than naive`);
  console.log('\nConsistent hashing:');
  console.log(`  ring points: ${m.consistentHashing.ringPoints}`);
  console.log(`  distribution: ${JSON.stringify(m.consistentHashing.distribution)}`);
  console.log('====================================================\n');
}

main().catch((e) => { console.error('Benchmark failed:', e.message); process.exit(1); });
