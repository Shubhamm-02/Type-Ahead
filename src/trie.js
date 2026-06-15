/**
 * trie.js — Prefix index for fast typeahead suggestions.
 * ======================================================
 *
 * THE PROBLEM
 *   When a user types "ip", we must instantly return the 10 most-searched
 *   queries that START WITH "ip" ("iphone", "iphone 15", ...). Scanning all
 *   120,000 queries on every keystroke is far too slow.
 *
 * THE DATA STRUCTURE: A TRIE (a.k.a. prefix tree)
 *   ANALOGY: think of a library where books are filed letter-by-letter.
 *   To find every book starting with "ip" you walk: shelf 'i' -> drawer 'p',
 *   and everything in that drawer matches. You never touch unrelated shelves.
 *
 *   Each node is one character. The path from the root to a node spells a
 *   prefix. A node may mark the end of a real query and hold its search count.
 *
 * THE OPTIMIZATION: TOP-K AT EVERY NODE
 *   A plain trie still needs to gather and sort ALL queries under a prefix.
 *   For a short prefix like "a" that could be thousands of matches.
 *   So we cache, AT EACH NODE, the node's own best 10 descendants (`topK`).
 *
 *   KEY INSIGHT (why this is correct): the top-10 queries under a node are
 *   always contained in the UNION of its children's top-10 lists (plus the
 *   node's own word, if it is itself a query). Reason: any query in a node's
 *   true top-10 lives in exactly one child subtree, and within that smaller
 *   subtree it can only rank HIGHER, so it is guaranteed to be in that
 *   child's top-10. Therefore we can rebuild a node's topK purely from its
 *   children — no full subtree scan needed.
 *
 *   Lookup then becomes: walk down the prefix (length L) and read the cached
 *   topK at the final node. O(L) — independent of dataset size.
 */

const K = 10; // we serve at most 10 suggestions

class TrieNode {
  constructor() {
    this.children = new Map(); // char -> TrieNode
    this.count = 0;            // search count IF this node ends a real query
    this.query = null;         // the full query string IF terminal, else null
    this.topK = [];            // cached best <=K descendants: [{query, count}]
  }
}

export class Trie {
  constructor() {
    this.root = new TrieNode();
    this.size = 0; // number of distinct queries stored
  }

  /** Normalize input so "IPhone ", "iphone" and "iPhone" are the same key. */
  static normalize(s) {
    return String(s).toLowerCase().trim().replace(/\s+/g, ' ');
  }

  /**
   * Insert a query or set its absolute count. Returns the path of nodes from
   * root to the terminal node so callers (increment) can refresh topK cheaply.
   */
  _insertPath(query) {
    let node = this.root;
    const path = [node];
    for (const ch of query) {
      let next = node.children.get(ch);
      if (!next) {
        next = new TrieNode();
        node.children.set(ch, next);
      }
      node = next;
      path.push(node);
    }
    return path;
  }

  /** Set a query's count to an absolute value (used during bulk load). */
  set(rawQuery, count) {
    const query = Trie.normalize(rawQuery);
    if (!query) return;
    const path = this._insertPath(query);
    const leaf = path[path.length - 1];
    if (leaf.query === null) this.size++;
    leaf.query = query;
    leaf.count = count;
    return path;
  }

  /**
   * Increment a query's count by `delta` (used when a search is submitted /
   * when a batch is flushed). Inserts the query if new, then refreshes the
   * cached topK lists along the path from the leaf up to the root.
   */
  increment(rawQuery, delta = 1) {
    const query = Trie.normalize(rawQuery);
    if (!query) return;
    const path = this._insertPath(query);
    const leaf = path[path.length - 1];
    if (leaf.query === null) {
      leaf.query = query;
      this.size++;
    }
    leaf.count += delta;
    // Refresh topK bottom-up: only nodes on this query's path can be affected.
    for (let i = path.length - 1; i >= 0; i--) {
      this._refreshTopK(path[i]);
    }
    return leaf.count;
  }

  /** Recompute a single node's topK from its own word + its children's topK. */
  _refreshTopK(node) {
    const candidates = [];
    if (node.query !== null) candidates.push({ query: node.query, count: node.count });
    for (const child of node.children.values()) {
      // child.topK already holds that subtree's best K — see KEY INSIGHT above.
      for (const item of child.topK) candidates.push(item);
    }
    candidates.sort((a, b) => b.count - a.count || (a.query < b.query ? -1 : 1));
    node.topK = candidates.slice(0, K);
  }

  /**
   * Build every node's topK once after a bulk load. Post-order DFS so each
   * node's children are finished before the node itself. O(number of nodes).
   */
  buildTopK() {
    const dfs = (node) => {
      for (const child of node.children.values()) dfs(child);
      this._refreshTopK(node);
    };
    dfs(this.root);
  }

  /** Walk down to the node representing `prefix`, or null if absent. */
  _nodeForPrefix(prefix) {
    let node = this.root;
    for (const ch of prefix) {
      node = node.children.get(ch);
      if (!node) return null;
    }
    return node;
  }

  /**
   * THE PUBLIC API: return up to 10 suggestions for a prefix, already sorted
   * by count descending. Empty prefix -> [] (we don't suggest on empty input).
   * No match -> []. This is O(prefix length).
   */
  suggest(rawPrefix, limit = K) {
    const prefix = Trie.normalize(rawPrefix);
    if (!prefix) return [];
    const node = this._nodeForPrefix(prefix);
    if (!node) return [];
    return node.topK.slice(0, limit);
  }
}
