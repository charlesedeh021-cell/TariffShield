# Privacy Policy History Join Scaling Investigation

**Issue**: Whether the `GET /privacy-policy-history` join query scales acceptably as the number of users and accepted-version records grows over time.

## Current Implementation (`apps/api/src/routes/privacy.ts:18-30`)

- GET `/privacy-policy-history` queries `privacy_policy_acceptances` joined with `privacy_policy_versions`
- Returns user's acceptance history with version details
- Route is gated by `authMiddleware` + `privacyReacceptanceGate` (auth.ts:147-183)
- The query performs a `JOIN` and `ORDER BY accepted_at DESC`

## Schema: `privacy_policy_acceptances` (db.ts:471-480)

```sql
CREATE TABLE IF NOT EXISTS privacy_policy_acceptances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  policy_version_id TEXT NOT NULL REFERENCES privacy_policy_versions(version_id),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address TEXT,
  acceptance_channel TEXT NOT NULL DEFAULT 'signup'
    CHECK (acceptance_channel IN ('signup', 'in_app', 'api')),
  UNIQUE (user_id, policy_version_id)
);
```

### Indexes (db.ts:482):
| Index | Purpose |
|---|---|
| `idx_privacy_acceptances_user` | `(user_id, accepted_at DESC)` — supports user history queries |

## Schema: `privacy_policy_versions` (db.ts:458-469)

```sql
CREATE TABLE IF NOT EXISTS privacy_policy_versions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  version_id TEXT UNIQUE NOT NULL,
  effective_date DATE NOT NULL,
  policy_text TEXT,
  s3_key TEXT,
  change_summary TEXT NOT NULL,
  requires_reacceptance BOOLEAN NOT NULL DEFAULT FALSE,
  published_by UUID REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

No additional indexes beyond PK on `version_id` and unique on `version_id`.

## Query Analysis

### The API query (`privacy.ts:20-28`):
```sql
SELECT ppa.policy_version_id, ppa.accepted_at, ppa.acceptance_channel,
       ppv.effective_date, ppv.change_summary, ppv.requires_reacceptance
FROM privacy_policy_acceptances ppa
JOIN privacy_policy_versions ppv ON ppv.version_id = ppa.policy_version_id
WHERE ppa.user_id = $1
ORDER BY ppa.accepted_at DESC
```

### Query plan components:
1. **`WHERE ppa.user_id = $1`** → filtered using `idx_privacy_acceptances_user` `(user_id, accepted_at DESC)` — ideal, covers both the user filter and the ORDER BY sort
2. **`JOIN privacy_policy_versions ppv ON ppv.version_id = ppa.policy_version_id`** → PK lookup on `privacy_policy_versions.id` (primary key), should be very fast (single-row lookup per acceptance row)
3. **`SELECT ...`** → projects 6 columns from both tables

### Ideal plan (with index):
```
Index Scan using idx_privacy_acceptances_user on privacy_policy_acceptances ppa 
  (cost=0.29..XX.XX rows=YYY rows_filtered=ZZZ)
  Order By: ppa.accepted_at DESC
  ->  Nested Loop Join 
       Join Cond: (ppa.policy_version_id = ppv.id)
       ->  Index Scan using privacy_policy_versions_pkey on privacy_policy_versions ppv
```

### Without the index:
```
Seq Scan on privacy_policy_acceptances ppa 
  Filter: (user_id = $1)
  Sort: ppa.accepted_at DESC  (separate sort step)
  ->  Nested Loop Join for each row
```

The index `idx_privacy_acceptances_user` is critical — it allows the planner to:
- Seek directly to the user's rows (index range scan on `user_id`)
- Return them already sorted by `accepted_at DESC` (no separate sort step)
- Then for each row, do a PK lookup on `privacy_policy_versions` by `version_id`

## Benchmark Plan

### 1. Current latency at current volume
- Measure `GET /privacy-policy-history` latency with current acceptance record count
- Capture EXPLAIN ANALYZE

### 2. Simulated 10x acceptance-record volume
- Insert 10x more `privacy_policy_acceptances` rows (e.g., 50 → 500 per user, or total table growth)
- Measure latency degradation
- Capture EXPLAIN ANALYZE

### 3. Simulated 10x version-count growth
- Add more `privacy_policy_versions` rows (multiple policy versions over time)
- Measure impact of version growth independent of user growth

### EXPLAIN ANALYZE Queries to Capture

#### Query with current data
```sql
EXPLAIN ANALYZE 
SELECT ppa.policy_version_id, ppa.accepted_at, ppa.acceptance_channel,
       ppv.effective_date, ppv.change_summary, ppv.requires_reacceptance
FROM privacy_policy_acceptances ppa
JOIN privacy_policy_versions ppv ON ppv.version_id = ppa.policy_version_id
WHERE ppa.user_id = $1
ORDER BY ppa.accepted_at DESC;
```

#### Verify index usage
```sql
-- Check index scan vs seq scan
SELECT 
  indexrelname, 
  idx_scan, 
  idx_tup_read, 
  idx_tup_fetch
FROM pg_stat_user_indexes 
WHERE indexrelname = 'idx_privacy_acceptances_user';
```

#### Range-growth test: user growth only (fixed version count)
```sql
-- Add acceptances for 10 new users with same 2 policy versions
-- Measure latency per user
```

#### Range-growth test: version count growth (fixed user count)
```sql
-- Add 10 new privacy_policy_versions
-- Measure join latency (should be constant — PK lookup per row)
```

### Key Metrics to Record

| Metric | Target | Notes |
|---|---|---|
| History query p95 (current volume) | < 50ms | With index, should be fast |
| History query p95 (10x acceptance volume) | < 100ms | Verify index still covers ORDER BY |
| History query p95 (10x version count) | < 100ms | Version growth should not degrade (PK lookups) |
| Index usage (idx_scan vs seq_scan) | idx_scan > 0 | Must use index, not sequential scan |
| Join cost per row | < 5ms per version row | Nested loop join on PK should be fast |
| Total rows returned p95 | varies by user acceptance count | Depends on how many versions user accepted |

### Recommendations

#### 1. Current Index is Well-Designed ✅
The existing `idx_privacy_acceptances_user` on `(user_id, accepted_at DESC)` is ideal for this query because:
- It matches the `WHERE ppa.user_id = $1` filter precisely
- It provides the `ORDER BY ppa.accepted_at DESC` sort order for free (index is pre-sorted)
- It avoids a separate filesort step in PostgreSQL

**No index changes needed** at current and 10x volume.

#### 2. Monitor Index Health
- Run `ANALYZE privacy_policy_acceptances` after data growth to update statistics
- Monitor `pg_stat_user_indexes.idx_scan` — should be > 0 after acceptance queries
- If `idx_scan = 0`, the index may be stale or the query pattern has changed
- If `idx_tup_read` grows disproportionately, the index may need `REINDEX`

#### 3. Version-Count Growth is Cheap (PK lookups)
The join `JOIN privacy_policy_versions ppv ON ppv.version_id = ppa.policy_version_id` looks up by `version_id`, which has:
- `PRIMARY KEY` on `id` → PK index
- `UNIQUE` on `version_id` → separate unique index

A PK lookup by UUID is essentially O(1) — constant time regardless of how many versions exist. Even at 100 versions, the join cost per acceptance row should be < 1ms.

**Version growth does not meaningfully degrade latency.**

#### 4. User-Count Growth with Fixed per-User Acceptance Count
If each user accepts ~2-3 policy versions (typical pattern:
- Initial signup acceptance
- One re-acceptance when policy updates)
- Then adding more users does NOT increase per-user query cost

The query is `WHERE ppa.user_id = $1` — a per-user filter. Each user's query scans only their own acceptance rows (2-3 rows with the index), regardless of total table size.

**User growth alone should not degrade latency.**

#### 5. Degradation Path: Many Acceptances Per User
If the acceptance pattern changes and users accumulate many `privacy_policy_acceptances` rows (e.g., 50+ versions accepted over many years):
- The index scan returns more rows per user
- The `ORDER BY accepted_at DESC` still benefits from the index pre-sort
- But the nested loop join multiplies: N acceptances × 1 version lookup each

**Mitigation**:
- Add retention policy: purge old acceptances beyond N versions (e.g., keep last 5)
- Or: denormalize `change_summary` and `requires_reacceptance` into `privacy_policy_acceptances` table, avoiding the join entirely
- Or: use a materialized view or cached endpoint that's refreshed on policy publish

#### 6. Caching for Free (recommendation)
Since the privacy policy history is typically:
- Read after login (user wants to see their acceptance history)
- Rarely changes within a session (new acceptances are discrete events)
- Expires when a new policy is published and user must re-accept

**Add Redis cache**: 
- Cache key: `privacy_history:userId` 
- TTL: until next policy publish event
- Response: return cached JSON if available, otherwise query DB and cache result
- This reduces DB load for the common "read history" use case

## Conclusion

**The `GET /privacy-policy-history` join query is well-optimized** due to the existing `idx_privacy_acceptances_user` index on `(user_id, accepted_at DESC)`. This index:

- ✅ Eliminates sequential scan for the `WHERE user_id` filter
- ✅ Provides free `ORDER BY accepted_at DESC` sort order
- ✅ Makes per-user query cost independent of total table size (only user's rows are scanned)
- ✅ Makes version-count growth irrelevant (PK lookups on `privacy_policy_versions` are constant-time)

**Projected scaling behavior**:

| Growth Scenario | Expected Impact | Reason |
|---|---|---|
| 10x more acceptance records (same users) | ⬎ < 2x latency | Index scan returns more rows per user, but still indexed; ORDER BY free |
| 10x more policy versions | ⬎ < 1.5x latency | PK lookups per acceptance row are constant-time; join is cheap |
| 10x more users (each with 2-3 acceptances) | ⬎ ~same latency | Per-user query scans only user's rows; index seeks directly to user |
| Users with 50+ acceptances each | ⬎ 2-5x latency | More rows scanned per user, but still indexed; may need retention |

**No immediate index changes needed**, but monitor index health and consider:
- Retention policy for old acceptances (purge beyond N versions)
- Redis caching for free read-reductions
- Denormalization if acceptance count per user grows unbounded

---

**Next Steps**:
- [ ] Create Node benchmark script to measure `GET /privacy-policy-history` latency at 3 volumes
- [ ] Capture EXPLAIN ANALYZE for the join query with current and grown data
- [ ] Simulate acceptance record growth and version count growth independently
- [ ] Run benchmarks and record metrics
- [ ] If index usage degrades, recommend REINDEX or retention policy
- [ ] Consider Redis caching layer for the privacy history endpoint
- [ ] Update docs/query-analysis.md with findings