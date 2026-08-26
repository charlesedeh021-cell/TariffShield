# Mass ToS Re-Acceptance Burst Investigation

**Issue**: Whether the `tos_acceptances` insert path has a unique-constraint check that becomes a bottleneck under concurrent mass re-acceptance, and whether write throughput degrades as the number of users and acceptance records grows.

## Current Implementation (`apps/api/src/routes/tos.ts:32-58`)

- POST `/accept-tos` inserts a new row into `tos_acceptances` table
- Insert includes `acceptance_method = 're-acceptance'`
- After insert, updates `users.tos_reacceptance_required = FALSE`
- Route is gated by `authMiddleware` + `tosReacceptanceGate` (auth.ts:185-215)
- Gate checks `SELECT tos_reacceptance_required FROM users WHERE id = $1` — async DB lookup

## Schema: `tos_acceptances` (db.ts:440-448)

```sql
CREATE TABLE IF NOT EXISTS tos_acceptances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tos_version TEXT NOT NULL REFERENCES tos_versions(version_id),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address TEXT,
  user_agent TEXT,
  acceptance_method TEXT NOT NULL CHECK (acceptance_method IN ('signup', 're-acceptance'))
);
```

### Indexes

| Index | Purpose |
|---|---|
| Primary key on `id` | Row-level PK |
| No index on `user_id` + `tos_version` | **Gap — no compound unique constraint in schema** |
| No index on `accepted_at` | — |

**Note**: The unique constraint "one active (non-revoked) key per prefix per user" is on `api_keys` (migration 003), NOT on `tos_acceptances`. However, business logic may enforce "one acceptance per tos_version per user" — the schema has **no such constraint**.

## Write Path Analysis

### Single insert query (`tos.ts:49-54`):
```sql
INSERT INTO tos_acceptances
   (user_id, tos_version, ip_address, user_agent, acceptance_method)
VALUES ($1, $2, $3, $4, 're-acceptance')
```

### Constraints checked on insert:
1. **Primary key** (`id`) — always checked
2. **Foreign key** `user_id → users(id)` — checked
3. **Foreign key** `tos_version → tos_versions(version_id)` — checked
4. **CHECK constraint** `acceptance_method IN ('signup', 're-acceptance')` — checked
5. **NOT NULL constraints** on all columns — checked

### Unique constraint: **NONE** currently defined on `tos_acceptances` (schema gap)

If the application expects "one acceptance per version per user", the enforcecer is entirely in the application layer (check before insert), not in the database. This means concurrent duplicates could be inserted unless the app handles it.

## Concurrent Burst Benchmark Plan

### Scenario: Mass re-acceptance after new ToS version publish
- Simulate N concurrent users all calling `POST /accept-tos` with the same `versionId`
- Measure: insert throughput (req/sec), avg latency, lock wait time, error rate (duplicate violations)

### 1. Low concurrency (10 concurrent)
- 10 parallel `POST /accept-tos` requests with same `versionId`
- Expected: All succeed, ~10ms each (idle DB)

### 2. Medium concurrency (50 concurrent)
- 50 parallel `POST /accept-tos` requests with same `versionId`
- Expected: Some may wait for lock, still succeed

### 3. High concurrency (200 concurrent)
- 200 parallel `POST /accept-tos` requests with same `versionId`
- Expected: Potential bottleneck at unique constraint check if one exists, or duplicate inserts if app doesn't guard

### EXPLAIN ANALYZE Queries to Capture

#### Insert with concurrent load
```sql
-- Measure insert path
EXPLAIN ANALYZE 
INSERT INTO tos_acceptances 
   (user_id, tos_version, ip_address, user_agent, acceptance_method)
VALUES ('user-uuid', 'v2.0.0', '127.0.0.1', 'Mozilla/5.0', 're-acceptance');
```

#### Check for lock waits under concurrency
```sql
-- PostgreSQL lock monitoring during concurrent inserts
SELECT 
  blocked_locks.pid AS blocked_pid, 
  blocked_locks.query AS blocked_query, 
  blocking_locks.pid AS blocking_pid, 
  blocking_locks.query AS blocking_query, 
  blocked_locks.mode AS blocked_mode, 
  blocking_locks.mode AS blocking_mode
FROM 
  pg_locks blocked_locks
  JOIN pg_stat_activity blocked ON blocked_pid = blocked.pid
  JOIN pg_locks blocking_locks 
    ON blocking_locks.locked = blocked_locks.locked AND blocking_locks.pid != blocked_locks.pid
  JOIN pg_stat_activity blocking ON blocking_pid = blocking.pid
WHERE 
  blocked_locks.pid = $1;
```

#### Verify uniqueness gap
```sql
-- Check if any unique index/constraint exists on tos_acceptances
SELECT 
  indexname, 
  tablename, 
  indexdef
FROM pg_indexes 
WHERE tablename = 'tos_acceptances';
```

## Key Metrics to Record

| Metric | Target | Notes |
|---|---|---|
| Insert latency p95 (10 concurrent) | < 50ms | Baseline with no contention |
| Insert latency p95 (50 concurrent) | < 100ms | Moderate contention |
| Insert latency p95 (200 concurrent) | < 200ms | **Risk zone** — unique constraint check may dominate |
| Duplicate insert rate (200 concurrent) | 0% | If app enforces uniqueness, should be 0; if not, may be > 0 |
| Lock wait time p95 | < 10ms | Time spent waiting for row-level lock |
| Pool waitingCount impact | < 5 | Monitor `pg_pool_waiting` gauge |

## Recommendations

### 1. Add Database-Level Unique Constraint (HIGH PRIORITY)
The `tos_acceptances` table lacks a unique constraint on `(user_id, tos_version)`. This means:
- **Without app guard**: Concurrent requests can insert duplicate acceptances for the same user+version
- **With app guard**: App must query first, then insert — race condition window exists

**Fix**: Add a partial/multi-column unique index:
```sql
CREATE UNIQUE INDEX idx_tos_acceptances_user_version
  ON tos_acceptances(user_id, tos_version)
  WHERE revoked_at IS NULL;  -- if soft-delete column added later
```

Or, if no soft-delete intent:
```sql
CREATE UNIQUE INDEX idx_tos_acceptances_user_version
  ON tos_acceptances(user_id, tos_version);
```

This prevents duplicates at the DB level, eliminating the race condition and making the insert path deterministic under concurrency.

### 2. If Unique Constraint Not Desired — Use UPSERT Pattern
If the business logic allows multiple acceptances (e.g., tracking acceptance history), use `INSERT ... ON CONFLICT DO NOTHING` or `ON CONFLICT DO UPDATE`:
```sql
INSERT INTO tos_acceptances 
   (user_id, tos_version, ip_address, user_agent, acceptance_method)
VALUES ($1, $2, $3, $4, 're-acceptance')
ON CONFLICT (user_id, tos_version) DO NOTHING;
```

Or to always update the latest acceptance:
```sql
INSERT INTO tos_acceptances 
   (user_id, tos_version, ip_address, user_agent, acceptance_method)
VALUES ($1, $2, $3, $4, 're-acceptance')
ON CONFLICT (user_id, tos_version) DO UPDATE SET
  accepted_at = now(),
  ip_address = EXCLUDED.ip_address,
  user_agent = EXCLUDED.user_agent;
```

### 3. Batch / Queue Processing for Mass Re-acceptance
If a new ToS version is published and hundreds/thousands of users need to re-accept:
- **Don't** hit the DB synchronously from the API
- Instead, publish a `tos-reacceptance-burst` event to a BullMQ queue
- Worker process batches the accepts, inserting in transactions of 50–100 rows
- Returns job ID; API responds `202 Accepted` with status URL

### 4. Monitor Pool Contention
The API uses `pg_pool_waiting` gauge (db.ts:57-78). During a burst:
- If `waitingCount` spikes > 5 for > 10s, the pool exhaustion logger fires (db.ts:82-98)
- Set up alerting if pool waiting exceeds threshold during known burst events

### 5. Review `tosReacceptanceGate` Performance
The gate at auth.ts:185-215 performs an async DB query:
```sql
SELECT tos_reacceptance_required FROM users WHERE id = $1
```
This is a single-row PK lookup (via `users` primary key) — should be < 5ms. However, under concurrent burst:
- 200 concurrent gate checks = 200 additional queries
- If pool is saturated, some requests will wait for connections
- Consider caching the `tos_reacceptance_required` flag in Redis for faster check

## Conclusion

**The `tos_acceptances` insert path currently has NO database-level unique constraint** on `(user_id, tos_version)`. This is a schema gap that risks:
- Duplicate acceptances under concurrent load (if app doesn't guard)
- Unnecessary lock contention during mass re-acceptance bursts
- Unpredictable insert latency growth as user count increases

**Recommendation**: Add a `UNIQUE INDEX` on `(user_id, tos_version)` to enforce one acceptance per user per ToS version at the database level. This:
- Eliminates race conditions under concurrency
- Allows PostgreSQL to optimize the insert (index check vs sequential scan)
- Makes latency predictable regardless of user count
- Complements the existing application gate without replacing it

If the business purpose is to track **history** of all acceptances (not enforce "one at a time"), use `ON CONFLICT DO NOTHING` / `ON CONFLICT DO UPDATE` with a compound index, and document that duplicate insert attempts are expected and handled at the app layer.

---

**Next Steps**:
- [ ] Run concurrent accept-tos benchmark (k6 or Node) at 10/50/200 VUs with same versionId
- [ ] Capture EXPLAIN ANALYZE of insert path with 50 vs 500 existing acceptances per user
- [ ] Decide on unique constraint approach and create migration 008 or alter table
- [ ] If adding unique index, update `tos.ts` route to use `ON CONFLICT DO NOTHING` or `DO UPDATE`
- [ ] Design batch re-acceptance job for mass ToS version publishing events
- [ ] Add `tos_reacceptance_required` caching layer (Redis) for faster gate checks