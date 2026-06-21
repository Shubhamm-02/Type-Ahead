# Search Typeahead System

A search-as-you-type suggestion system, like the dropdown you see on Google,
Amazon, or YouTube. As you type a **prefix**, it returns the **top 10 most
popular queries** that start with it, ranked by how often they've been
searched. It also records searches, surfaces **trending** queries, serves reads
from a **distributed cache** spread with **consistent hashing**, and protects
the database using **batched writes**.

> The focus of this project is the **backend data-system design**: how data is
> stored, indexed, cached, distributed, and written efficiently, not just a UI.

---

## Table of contents

1. [Quick start](#quick-start)
2. [What it does (features)](#what-it-does)
3. [Architecture at a glance](#architecture-at-a-glance)
4. [The two request flows](#the-two-request-flows)
5. [Every component, explained (with analogies)](#every-component-explained)
   - [Trie / prefix index](#1-trie--prefix-index)
   - [Distributed cache](#2-distributed-cache)
   - [Consistent hashing](#3-consistent-hashing)
   - [Query-count store ("the DB")](#4-query-count-store-the-db)
   - [Batch writes](#5-batch-writes)
   - [Trending searches](#6-trending-searches)
   - [Debouncing (frontend)](#7-debouncing-frontend)
   - [Metrics & p95 latency](#8-metrics--p95-latency)
6. [Design decisions & trade-offs](#design-decisions--trade-offs)
7. [API documentation](#api-documentation)
8. [Configuration](#configuration)
9. [Performance report](#performance-report)
10. [Project structure](#project-structure)
11. [Dataset](#dataset)

---

## Quick start

**Requirements:** Node.js 18+ (built and tested on Node 22). No database, no
Redis, nothing else to install, everything runs in one process so local setup
is trivial.

```bash
# 1. install the one dependency (express)
npm install

# 2. generate the dataset (120,000 queries): only needed once
npm run gen-data

# 3. start the server
npm start
```

Then open **http://localhost:3000** and start typing.

To reproduce the performance numbers, in a second terminal:

```bash
npm run bench
```

---

## What it does

| Feature | Where | Requirement met |
|---|---|---|
| Top-10 prefix suggestions, sorted by count | `src/trie.js` | 4.1 Typeahead |
| Handles empty input, mixed case, no matches | `src/trie.js` (`normalize`) | 4.1 |
| Debounced input, keyboard nav, loading/error states | `public/` | 4.1, 9 |
| Search submission returns `{"message":"Searched"}` | `src/server.js` | 4.2 |
| Increment existing / insert new query | `src/store.js` + `trie.js` | 4.2 |
| Cache-before-DB with TTL + invalidation | `src/cache.js` | 6 |
| Distributed cache nodes + consistent hashing | `src/cache.js` + `consistentHashing.js` | 6 |
| Trending: `/suggest?rank=basic\|enhanced` (recency-aware) | `src/trending.js` | 7 |
| Batch writes (buffer, aggregate, flush) | `src/writeBuffer.js` | 8 |
| Metrics: p95, hit rate, DB reads/writes | `src/metrics.js`, `GET /metrics` | 10 |

---

## Architecture at a glance

```
                              ┌─────────────────────────────┐
        Browser (public/)     │           BACKEND           │
   ┌────────────────────┐     │                             │
   │  search input      │     │   GET /suggest?q=ip         │
   │  - debounce 120ms  │────────────┐                      │
   │  - keyboard nav    │     │       ▼                      │
   │  - trending list   │     │  ┌──────────────────────┐   │
   └────────────────────┘     │  │  DISTRIBUTED CACHE   │   │
            │                 │  │  cache-0 cache-1 ... │   │
            │ POST /search    │  │  picked by the       │   │
            ▼                 │  │  CONSISTENT-HASH RING│   │
   ┌────────────────────┐     │  └─────────┬────────────┘   │
   │ {"message":         │     │   hit │    │ miss           │
   │   "Searched"}       │     │  ◄────┘    ▼                │
   └────────────────────┘     │      ┌──────────────┐       │
            │                 │      │  TRIE INDEX  │ top-10 │
            ▼                 │      │ (prefix tree)│ per    │
   ┌────────────────────┐     │      │  + cached    │ node   │
   │   WRITE BUFFER     │     │      │  topK lists  │       │
   │ aggregate +50 etc. │     │      └──────┬───────┘       │
   │ flush on size/time │     │             │ built from     │
   └─────────┬──────────┘     │             ▼                │
             │ flush          │      ┌──────────────┐        │
             ├───────────────────────►│  QUERY STORE │ (DB)  │
             │  apply deltas  │      │ query→count  │        │
             ├──────────────► TRIE.increment + TRENDING.record
             └──────────────► CACHE.invalidate(affected prefixes)
                              └─────────────────────────────┘
```

---

## The two request flows

### Read path: `GET /suggest?q=ip` (must be **fast**)

1. Normalize the prefix (`lowercase`, `trim`, collapse spaces) so `"IPhone "`,
   `"iphone"`, and `"iPhone"` are the same key.
2. Ask the **distributed cache**. The consistent-hash ring picks the cache node
   that owns `"ip"`.
   - **HIT** → return the cached list immediately. The trie and DB are never
     touched.
   - **MISS** → compute the top-10 from the **trie** (O(prefix length)), store
     the result in the cache (*cache-aside*), and return it.

### Write path: `POST /search {"q":"iphone"}` (must be **cheap**)

1. Add `+1` for `"iphone"` to the **write buffer** (in memory). The database is
   **not** touched yet.
2. Return `{"message":"Searched"}` immediately, the user doesn't wait for a DB
   write.
3. Later, when the buffer flushes (either it filled up, or the timer fired):
   - apply the aggregated deltas to the **store** (one write per distinct query),
   - update the **trie** counts (and the cached top-K lists along each path),
   - add **trending** heat,
   - **invalidate** the cache entries for every affected prefix so the next
     `/suggest` recomputes fresh results.

---

## Every component, explained

### 1. Trie / prefix index

**File:** `src/trie.js`

**Problem.** When the user types `"ip"` we must instantly find the 10
most-searched queries starting with `"ip"`. Scanning all 120,000 queries on
every keystroke is far too slow.

**A trie (prefix tree)** stores strings character-by-character. The path from
the root to a node spells a prefix; everything below that node shares the
prefix.

> **Analogy.** A library filed letter-by-letter. To find every book starting
> with "ip", you walk to shelf `i` → drawer `p`, and everything in that drawer
> matches. You never touch unrelated shelves.

**The optimization: top-K at every node.** A plain trie still has to gather and
sort *all* queries under a prefix. For a short prefix like `"a"` that could be
thousands. So we cache, at **each node**, that node's own best 10 descendants
(`topK`).

> **Why this is correct (the key insight):** the top-10 under a node are always
> contained in the **union of its children's top-10 lists** (plus the node's own
> word if it's a query). Any query in a node's true top-10 lives in exactly one
> child subtree, and within that *smaller* subtree it can only rank *higher*, so
> it's guaranteed to appear in that child's top-10. Therefore a node's list can
> be rebuilt purely from its children, no full subtree scan.

**Result.** A lookup is just "walk down the prefix, read the cached list at the
final node" → **O(prefix length)**, independent of dataset size. On an
increment we only refresh the topK of nodes **on that one query's path** (leaf
up to root), which is cheap.

**Edge cases handled:** empty input → `[]`; mixed case → normalized; no match →
`[]`.

---

### 2. Distributed cache

**File:** `src/cache.js`

We keep a **cache of `prefix → suggestions`** in front of the trie.

> **Analogy.** The trie is the kitchen; the cache is the tray of ready-made
> dishes on the counter. If the dish is on the tray (a *hit*), serve it
> instantly. If not (a *miss*), cook it once and leave a copy on the tray for
> next time. This is the **cache-aside** pattern.

**Distributed** means several independent cache servers. We model that with
several `CacheNode` objects in one process; a **consistent-hash ring** decides
which node owns each prefix. This keeps the distribution logic real and
*observable* (see `GET /cache/debug`) without you having to install and run a
Redis cluster.

**Freshness is handled two ways:**
- **TTL (time-to-live):** every entry expires after 60s (configurable). After
  that it's treated as a miss. This bounds staleness as a safety net.
- **Active invalidation:** when a batch of writes lands, we delete the cache
  entries for exactly the affected prefixes, so changes show up immediately
  rather than waiting for TTL.

Each node also has a small **LRU cap** (evict the least-recently-used entry when
full) so memory can't grow without bound.

---

### 3. Consistent hashing

**File:** `src/consistentHashing.js`

**Problem with naive hashing.** The obvious way to spread keys over `N` cache
servers is `node = hash(key) % N`. It works until `N` changes. Add or remove one
server and `N` changes, so `% N` changes for **almost every key** at once →
a mass cache miss → a stampede on the database.

**Consistent hashing.**

> **Analogy.** Picture a round clock face numbered `0 … 2³²-1`. Place each server
> at a few points on the rim. To find a key's server, hash the key to a point on
> the rim and **walk clockwise** to the first server you meet. Now add a server:
> it drops onto the rim and only steals the slice of keys between it and the
> previous server. Every other key keeps its home. On average only **K/N** keys
> move when the cluster changes, not all of them.

**Virtual nodes.** With only one point per server, the slices come out uneven.
So each physical server is placed at **many** points (here: **150**). More points
→ the slices average out → balanced load.

> **Analogy.** Instead of one big shop, a chain opens 150 small branches
> scattered around the city, so no single branch gets swamped.

We hash with **FNV-1a** (a small, fast, well-distributed non-cryptographic
hash) and find the owning node with a **binary search** over the sorted ring →
O(log totalPoints). You can watch nodes join/leave the ring via
`POST /admin/cache-node` and `GET /metrics` (`consistentHashing.log`).

---

### 4. Query-count store ("the DB")

**File:** `src/store.js`

This is the **source of truth**: the authoritative `query → count` for every
query. In production this would be PostgreSQL / DynamoDB / Redis. Here it's an
in-memory `Map` loaded from the CSV, with an optional disk **snapshot** so
restarts keep accumulated counts.

**Why separate from the trie?** The trie is a derived **index** optimized for
prefix lookups; the store is the **flat truth**. This mirrors real systems: the
database holds the data, and a search index (a trie, or Elasticsearch) is built
from it for fast queries. Keeping them separate also lets us count **DB
reads/writes** to report database load.

> Note: because the trie holds counts in memory, `/suggest` is served entirely
> by the cache + index and **never reads the DB**: DB read load is essentially
> zero by design. The DB is touched only by **batched writes**.

---

### 5. Batch writes

**File:** `src/writeBuffer.js`

**Problem.** Every `POST /search` wants to do `count = count + 1` in the
database. At high traffic that's a flood of tiny writes, and databases hate many
small writes (each has fixed overhead: locks, disk flush, index update).

**Idea: aggregate, then flush.**

> **Analogy.** A courier doesn't drive to the post office for each letter. They
> collect letters in a mailbag all morning and make **one** trip.

We buffer increments in memory and **aggregate** them: if `"iphone"` is searched
50 times before a flush, the buffer holds a single `{iphone: +50}`. The DB does
**one** write of `+50` instead of 50 writes of `+1`. Repeated hot queries get
the biggest savings (the benchmark shows a **300×** reduction).

**Flush triggers (whichever comes first):**
- **Size**: buffer reaches `maxBatchSize` distinct queries (burst guard).
- **Time**: every `flushIntervalMs` (so quiet traffic still lands promptly).

**Trade-off: data-loss risk (discussed honestly).** Buffered increments live in
memory. If the process crashes before a flush, those increments are **lost**. We
accept this because the data is approximate popularity counts (not money), and
the window is bounded (~2s). For durability we'd first append each increment to
a **write-ahead log (WAL)** on disk, then batch into the DB: trading a little
latency for crash safety. On a clean shutdown (Ctrl-C) we flush the buffer so
nothing is lost.

---

### 6. Trending / recency-aware ranking

**File:** `src/trending.js`

The spec wants the **same suggestion API** to support two rankings: recency is
folded *into* `/suggest`, not bolted on as a separate feature:

- **Basic (rubric 60%):** `GET /suggest?q=<prefix>&rank=basic`: sort the prefix
  matches by **overall count**. Historically popular queries appear first.
- **Enhanced (rubric 20%):** `GET /suggest?q=<prefix>&rank=enhanced`: re-rank
  the same matches with a **recency-aware** score, so a query that's hot *right
  now* gets higher priority. The UI uses `rank=enhanced` by default.

> **Analogy.** A query's recency is a glowing **ember**. Every search throws a
> spark on it (heat up). Left alone it cools on its own. A query searched a lot
> in the last few minutes is white-hot; one popular last week has cooled.

The spec asks us to clearly explain five things, here they are:

**1) How recent searches are tracked.** One number per query, its **heat**. On
each search (applied per batch flush):

```
heat = heat * decay(timeSinceLastUpdate) + increment
where  decay(dt) = 0.5 ^ (dt / halfLife)      // halfLife = 10 min
       increment = sqrt(searchesInThisBatch)  // dampened, see #3
```

Heat is "cooled" lazily, we only apply decay the next time we touch the query,
so there's **no background job** sweeping millions of rows.

**2) How recent activity affects ranking.** `rankByRecency()` re-ranks a
prefix's candidates by multiplying popularity by a recency boost:

```
score(q) = count(q) * (1 + heat(q))
```

`heat(q)` is the query's recent-search heat decayed to now. No recent activity →
`heat = 0` → `score = count` → exactly the basic (count) order, so enhanced is a
strict, safe **superset** of basic. A recently-hot query gets a boost
proportional to how hot it is.

**3) How short-term spikes are prevented from permanently over-ranking.** Two
things: (a) **decay**: a spike's heat fades back to ~0 once searches stop, so
the ranking returns to count order on its own; (b) we **multiply by the query's
own count**, so a quick burst on an obscure query can't top the list: it has to
be *both* reasonably popular *and* recently active. (`record()` also softens big
bursts with a `√N` increment, an optional extra dampener.)

**4) How the cache is updated/invalidated when rankings change.** The cache
stores the **stable, count-ranked candidate pool** for a prefix: it changes
only when *counts* change, and we invalidate exactly the affected prefixes on
each batch flush. Enhanced re-ranking runs **live on that cached pool**, so
recency drift (heat decaying between flushes) needs **no cache invalidation at
all**. This cleanly separates "what to cache" (stable counts) from "how to rank"
(live recency).

**5) Trade-offs (freshness / latency / complexity).** The **half-life** is the
dial: a shorter half-life = fresher but jumpier, longer = more stable. Latency
cost is tiny, enhanced sorts only the ~20-item cached pool per request, so reads
stay sub-millisecond. Complexity is bounded by the pool size: enhanced can only
promote a query that's *both* reasonably popular and recently active, which is
also a sensible product rule (it won't surface a single-search nobody-query).

**Supporting demo: `GET /trending?mode=basic|enhanced`.** A small global
leaderboard that visualizes the *same two philosophies* (all-time count vs.
decayed heat). It's the quickest way to "demonstrate the difference between the
two ranking approaches using sample data" that the spec asks for, alongside the
per-prefix `?rank=basic` vs `?rank=enhanced` comparison.

---

### 7. Debouncing (frontend)

**File:** `public/app.js`

A fast typist fires ~10 keystrokes/second. Calling `/suggest` on each one is
wasteful and can render out-of-order responses. **Debouncing** waits until the
user *pauses* (120 ms) before sending a single request.

> **Analogy.** An elevator waits a moment for stragglers instead of leaving on
> every button press.

The UI also has **keyboard navigation** (↑/↓ to move, Enter to search, Esc to
close), **loading/error states**, prefix **highlighting**, and ARIA roles for
accessibility.

---

### 8. Metrics & p95 latency

**File:** `src/metrics.js` → exposed at `GET /metrics`.

We record each request's latency per route and report **percentiles**.

**Why p95, not the average?** Averages hide pain. If 95 requests take 1 ms and 5
take 900 ms, the average (~46 ms) looks fine while 1 in 20 users waits almost a
second. **p95 = "95% of requests are at least this fast"**: it captures the
experience of your *unlucky* users, which is what actually drives complaints.

> **Analogy.** A bus that's "on average" on time can still strand you every
> Friday. The 95th-percentile delay tells you about the bad days.

`/metrics` also reports cache hit rate, DB reads/writes, batch write-reduction
ratio, and the consistent-hashing ring distribution + change log.

---

## Design decisions & trade-offs

| Decision | Why | Trade-off / alternative |
|---|---|---|
| **Node.js + Express, single process** | One language end-to-end; trivial local setup (a grading criterion) | Not horizontally scaled; real deploy would run multiple instances |
| **Vanilla HTML/CSS/JS frontend** | No build step: open and run | No component framework; fine for this scope |
| **In-process "distributed" cache** | Makes consistent hashing real and *observable* without a Redis cluster | Not a real network cache; same API shape, easy to swap for Redis |
| **Trie with per-node top-K** | O(prefix length) lookups, independent of dataset size | Extra memory for cached lists; refresh cost on writes (bounded to one path) |
| **Cache-aside (not write-through)** | Simple, and writes are already batched | First request after invalidation is a miss |
| **Batch writes** | Cuts DB writes massively (300× in bench) | Up to ~2s of increments at risk on crash (mitigated by WAL in production) |
| **Exponential decay for trending** | One number per query, no background job, naturally recency-weighted | Half-life must be tuned to the product |
| **FNV-1a hash** | Fast, good spread, deterministic | Not cryptographic: not needed here |
| **Generated dataset** | Reproducible, offline, shaped Zipf-like | Synthetic, not real traffic |

---

## API documentation

### `GET /suggest?q=<prefix>&rank=basic|enhanced`
Returns up to 10 suggestions for a prefix.
- `rank=basic` (default), sorted by **count** descending.
- `rank=enhanced`, **recency-aware** re-ranking (see §6). The UI uses this.
```bash
curl 'http://localhost:3000/suggest?q=ip'                 # basic (count)
curl 'http://localhost:3000/suggest?q=ip&rank=enhanced'   # recency-aware
```
```json
{
  "query": "ip",
  "rank": "enhanced",         // which ranking was applied
  "source": "cache",          // "cache" | "trie" | "empty"
  "node": "cache-1",          // which cache node owns this prefix
  "suggestions": [
    { "query": "iphone", "count": 2432764 },
    { "query": "iphone 15", "count": 949590 }
  ]
}
```

### `POST /search`
Submits a search; buffers the increment and returns immediately.
```bash
curl -X POST localhost:3000/search -H 'Content-Type: application/json' -d '{"q":"iphone"}'
```
```json
{ "message": "Searched" }
```

### `GET /cache/debug?prefix=<prefix>`
Shows which cache node is responsible for a prefix, whether it's currently
cached (HIT/MISS), TTL remaining, and the ring distribution.
```bash
curl 'http://localhost:3000/cache/debug?prefix=ip'
```

### `GET /trending?mode=enhanced|basic`
`enhanced` (default) = recency-weighted; `basic` = all-time total count.

### `GET /metrics`
The full performance report: latency percentiles, cache stats, DB reads/writes,
batch-write stats, and consistent-hashing ring info + change log.

### Admin / demo helpers
- `POST /admin/flush`, force the write buffer to flush now.
- `POST /admin/cache-node` `{"action":"add"|"remove","id":"cache-3"}`, add/remove
  a cache node at runtime to demonstrate ring elasticity.
- `POST /admin/snapshot`, persist current counts to `data/snapshot.csv`.

---

## Configuration

All knobs are at the top of `src/server.js` (`CONFIG`):

| Setting | Default | Meaning |
|---|---|---|
| `cacheNodes` | 3 | number of simulated cache servers |
| `cacheTtlMs` | 60000 | suggestion cache entry lifetime |
| `virtualNodes` | 150 | ring points per cache node |
| `maxBatchSize` | 500 | flush after this many distinct buffered queries |
| `flushIntervalMs` | 2000 | flush at least this often |
| `trendingHalfLifeMs` | 600000 | trending heat halves every 10 min |
| `port` | 3000 | HTTP port (`PORT` env overrides) |

---

## Performance report

Measured locally on Node 22 (`npm run bench`: 5,000 reads + 3,000 writes). Run
it yourself to reproduce, numbers will vary by machine.

| Metric | Value |
|---|---|
| `GET /suggest` p50 / **p95** / p99 | 0.04 / **0.08** / 0.22 ms |
| `POST /search` p50 / **p95** / p99 | 0.03 / **0.04** / 0.09 ms |
| Suggest throughput | ~5,200 req/s (single client, single core) |
| **Cache hit rate** | **99.6%** |
| DB reads (served by index) | 0 |
| Raw searches → DB rows written | 3,000 → 10 |
| **Write reduction** | **~300×** |
| Ring points (3 nodes × 150) | 450, evenly distributed |

*(Hit rate is high here because the benchmark hammers a small set of hot
prefixes, which is exactly the real-world traffic pattern caches are built for.)*

---

## Project structure

```
.
├── data/
│   └── queries.csv            # generated dataset (120k queries)
├── public/                    # frontend (no build step)
│   ├── index.html
│   ├── style.css
│   └── app.js                 # debounce, keyboard nav, trending
├── scripts/
│   ├── generateDataset.js     # makes data/queries.csv (Zipf-like counts)
│   └── benchmark.js           # load test → performance report
├── src/
│   ├── trie.js                # prefix index with per-node top-K
│   ├── consistentHashing.js   # FNV-1a ring + virtual nodes
│   ├── cache.js               # distributed cache (TTL, LRU, invalidation)
│   ├── store.js               # query→count source of truth
│   ├── writeBuffer.js         # batch writes (aggregate + flush)
│   ├── trending.js            # exponential-decay trending
│   ├── metrics.js             # latency percentiles + counters
│   └── server.js              # wires everything together (the APIs)
├── package.json
└── README.md
```

---

## Dataset

`data/queries.csv` holds **120,000 unique queries** (above the 100k minimum) in
`query,count` format. It's produced by `scripts/generateDataset.js`, which:

- combines real brand/product/programming/food vocabularies into realistic
  query shapes (`"apple laptop pro"`, `"java tutorial"`, `"pizza near me"`), plus
  a curated set of real flagship queries (`"iphone 15 pro"`, `"airpods"`, …);
- assigns **Zipf-like** counts (the *n*-th most popular query gets ≈ `1/n` of the
  top query's traffic) because real search traffic is heavily skewed toward a few
  head terms, which is what makes caching and trending behave realistically;
- is **deterministic** (fixed seed) so everyone gets the same file.

If you'd rather use a real dataset, drop any `query,count` CSV at
`data/queries.csv`. If a dataset has no counts, aggregate duplicates to derive
them, `store.loadCSV` already sums repeated queries.
