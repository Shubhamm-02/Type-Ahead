# Search Typeahead System Assignment

## 1. Overview

In this assignment, students will build a **search typeahead system** similar to the suggestion feature seen in search engines, e-commerce platforms, and content platforms.

The system should:

* Suggest popular search queries while the user is typing
* Support search submissions
* Update query popularity
* Use caching for low-latency reads

The focus is on **backend data-system design**, including:

* Query-count storage
* Fast suggestion retrieval
* Cache distribution
* Write optimization

---

## 2. Problem Statement

Build a search typeahead application with:

1. Show **top 10 suggestions** sorted by search count while typing
2. UI for search + suggestions
3. Backend dummy search API (`"Searched"`)
4. Update query-count store on search submission
5. Design storage + caching strategy
6. Use **distributed cache with consistent hashing**
7. Support **trending searches**
8. Implement **batch writes**

---

## 3. Dataset Requirement

Use any dataset containing:

* Search queries / keywords / product names / titles

Format:

```
query,count
iphone,100000
iphone 15,85000
iphone charger,60000
java tutorial,40000
```

* Minimum size: **100,000 queries**
* If counts missing → derive via aggregation

---

## 4. Functional Requirements

### 4.1 Typeahead Suggestions

* Return **max 10 suggestions**
* Must match prefix
* Sort by **count (descending)**
* Handle:

  * Empty input
  * Mixed case
  * No matches
* UI should use **debouncing**

---

### 4.2 Search Submission

* Return:

```json
{ "message": "Searched" }
```

* Update query store:

  * If exists → increment count
  * If new → insert

* Updates should reflect in:

  * Suggestions
  * Trending searches

---

## 5. API Expectations

### GET /suggest?q=<prefix>

* Returns top 10 suggestions

### POST /search

* Submits query
* Returns `"Searched"`

### GET /cache/debug?prefix=<prefix>

* Shows:

  * Cache node responsible
  * Hit / miss

---

## 6. Data Storage & Caching

* Store query-count data reliably
* Use cache before DB
* Cache stores:

  * Prefix → suggestions

### Requirements:

* Cache expiry / invalidation
* Distributed cache nodes
* Use **consistent hashing**

---

## 7. Trending Searches

### Basic (60%)

* Sort by **total count**

### Enhanced (20%)

* Include **recency**

### Must explain:

* How recent searches are tracked
* Ranking formula
* Prevent short-term spikes dominating
* Cache update strategy

---

## 8. Batch Writes

Goal: Reduce DB writes

### Requirements:

* Buffer / queue writes
* Aggregate repeated queries
* Flush:

  * Periodically OR
  * On batch size

### Must discuss:

* Write reduction
* Failure trade-offs (data loss risk)

---

## 9. UI Requirements

* Search input
* Suggestion dropdown
* Submit via Enter / button
* Show response
* Trending section
* Loading & error states
* Keyboard navigation
* Clean UI

---

## 10. Non-Functional Expectations

* Easy local setup

* Low-latency suggestions

* Report:

  * p95 latency
  * Cache hit rate
  * DB reads/writes

* Show:

  * Consistent hashing logs

* Code should be:

  * Modular
  * Readable
  * Documented

---

## 11. AI Usage Policy

* AI tools allowed
* You must **understand everything**

### Must explain:

* Data modeling
* Caching
* Consistent hashing
* Trending logic
* Batch writes

Failure → treated as plagiarism

---

## 12. Expected Submission

* GitHub repo
* README (setup + explanation)
* Dataset source
* Architecture diagram
* API docs
* Demo (screenshots/video)
* Performance report

---

## 13. Grading Rubric (100 Marks)

| Component            | Marks | Description            |
| -------------------- | ----- | ---------------------- |
| Basic Implementation | 60    | Working system + cache |
| Trending Searches    | 20    | Recency-based ranking  |
| Batch Writes         | 20    | Write optimization     |

---

## 14. Suggested Milestones

1. Load dataset + basic API
2. Build frontend UI
3. Add search submission
4. Add distributed cache
5. Implement trending
6. Add batch writes
7. Measure performance

---

## Bonus Tips

* Use:

  * Trie / Prefix index for fast lookup
  * Redis (or in-memory cache)
* Keep system observable:

  * Logs
  * Metrics

---
