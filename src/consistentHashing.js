/**
 * consistentHashing.js — Distributing cache keys across nodes.
 * ===========================================================
 *
 * THE PROBLEM WITH PLAIN HASHING
 *   The obvious way to spread keys over N cache servers is:
 *       node = hash(key) % N
 *   It works until N changes. Add or remove ONE server and N changes, so
 *   `% N` changes for almost EVERY key. Nearly the whole cache is suddenly
 *   pointing at the wrong node => a mass cache miss => a stampede on the DB.
 *
 * CONSISTENT HASHING
 *   ANALOGY: imagine a round clock face (0 .. 2^32-1). We place each server
 *   at a few positions on the rim. To find a key's server, hash the key to a
 *   point on the rim and walk CLOCKWISE to the first server you meet.
 *
 *   Now add a server: it drops onto the rim and only "steals" the slice of
 *   keys between it and the previous server. Every other key keeps its home.
 *   Removing a server only re-homes that server's slice to the next one
 *   clockwise. On average only K/N keys move when nodes change — not all of
 *   them. THAT is the whole point.
 *
 * VIRTUAL NODES (replicas)
 *   With only one point per server, the slices come out uneven and load is
 *   lopsided. So each physical server is placed at MANY points on the rim
 *   (here: 150 "virtual nodes"). More points => the slices average out =>
 *   smooth, balanced load. ANALOGY: instead of one big shop, a chain opens
 *   150 small branches scattered around the city so no single branch is
 *   swamped.
 */

/**
 * FNV-1a, 32-bit — a small, fast, well-distributed non-cryptographic hash.
 * We need a deterministic string -> 32-bit number mapping for the ring.
 * (We don't need cryptographic security here, just good spread + speed.)
 */
export function fnv1a(str) {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // hash *= 16777619 (FNV prime), kept in 32-bit range via Math.imul
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0; // force unsigned 32-bit
}

export class ConsistentHashRing {
  /**
   * @param {string[]} nodes        initial node ids, e.g. ['cache-0', ...]
   * @param {number}   virtualNodes points on the ring per physical node
   */
  constructor(nodes = [], virtualNodes = 150) {
    this.virtualNodes = virtualNodes;
    this.ring = [];          // sorted array of { hash, node }
    this.nodes = new Set();  // physical node ids currently on the ring
    this.log = [];           // human-readable audit trail of ring changes
    for (const n of nodes) this.addNode(n, /*silent=*/true);
    this._sort();
    this._record(`ring initialized with ${this.nodes.size} nodes, ` +
      `${this.virtualNodes} virtual nodes each (${this.ring.length} points)`);
  }

  _sort() { this.ring.sort((a, b) => a.hash - b.hash); }

  _record(msg) {
    // timestamp added lazily; kept short so the log stays readable in /metrics
    this.log.push({ t: new Date().toISOString(), msg });
    if (this.log.length > 200) this.log.shift();
  }

  /** Place a physical node at `virtualNodes` points around the ring. */
  addNode(node, silent = false) {
    if (this.nodes.has(node)) return;
    this.nodes.add(node);
    for (let i = 0; i < this.virtualNodes; i++) {
      this.ring.push({ hash: fnv1a(`${node}#${i}`), node });
    }
    if (!silent) {
      this._sort();
      this._record(`+ added node ${node} (now ${this.nodes.size} nodes)`);
    }
  }

  /** Remove a physical node and all of its virtual points. */
  removeNode(node) {
    if (!this.nodes.has(node)) return;
    this.nodes.delete(node);
    this.ring = this.ring.filter((p) => p.node !== node);
    this._record(`- removed node ${node} (now ${this.nodes.size} nodes)`);
  }

  /**
   * THE CORE LOOKUP: which node owns this key?
   * Hash the key, then binary-search for the first ring point whose hash is
   * >= the key's hash ("walk clockwise"); wrap around to point 0 if past the
   * end. O(log totalPoints).
   */
  getNode(key) {
    if (this.ring.length === 0) return null;
    const h = fnv1a(key);
    let lo = 0, hi = this.ring.length - 1, ans = 0;
    if (h > this.ring[hi].hash) return this.ring[0].node; // wrap around
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash >= h) { ans = mid; hi = mid - 1; }
      else { lo = mid + 1; }
    }
    return this.ring[ans].node;
  }

  /** Diagnostics: how the virtual points are distributed per physical node. */
  distribution() {
    const counts = {};
    for (const p of this.ring) counts[p.node] = (counts[p.node] || 0) + 1;
    return counts;
  }
}
