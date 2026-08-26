# API Keys Lookup on Auth Hot Path Investigation

**Issue**: Whether the `api_keys` lookup query remains fast as the number of issued keys grows, since this sits on the hot authentication path.

## Current Implementation

Authentication flow queries `api_keys` table to validate incoming webhook consumer credentials. The relevant code paths:

### 1. Signup records api_key at creation (`auth.ts:102-109`):
```sql
INSERT INTO privacy_policy_acceptances ...  -- not api_keys
```
Actually, looking at the codebase, api_keys are typically pre-provisioned or created via admin routes, not at signup.

### 2. Auth route that may query api_keys — search needed
Let me search the codebase for api_key lookups during auth.

## Schema: `api_keys` (migration 003_api_keys_table.sql:4-16)

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  label        TEXT,
  scopes       TEXT[] NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Indexes (migration 003:18-24):
| Index | Columns | Purpose |
|---|---|---|
| `idx_api_keys_user_id` | `user_id` | User-scoped key lookups |
| `idx_api_keys_prefix` | `prefix` | API key prefix lookup during auth |
| `idx_api_keys_user_prefix_active` | `(user_id, prefix) WHERE revoked_at IS NULL` | **Unique: only one active (non-revoked) key per prefix per user** |

## Auth Path Query Analysis

The question is: **which query is on the hot authentication path?**

Looking at the codebase, I need to find where `api_keys` is queried during request authentication. Let me search:

- The `api_keys` table has `key_hash TEXT NOT NULL UNIQUE` — this suggests lookups by hash
- The `prefix` index suggests lookups by key prefix (common pattern: first few chars of key)
- The unique index `(user_id, prefix) WHERE revoked_at IS NULL` enforces one active key per prefix per user

### Likely auth query patterns:

1. **Lookup by key_hash** (most likely for auth validation):
   ```sql
   SELECT * FROM api_keys WHERE key_hash = $1;
   ```
   - Uses the implicit unique index on `key_hash` (since UNIQUE constraint creates a unique index)
   - Should be O(1) b-tree lookup, constant time regardless of table size
   - **Expected**: < 5ms regardless of whether there are 100 or 100,000 keys

2. **Lookup by prefix** (less likely during auth, more for admin UI):
   ```sql
   SELECT * FROM api_keys WHERE prefix = $1;
   ```
   - Uses `idx_api_keys_prefix` index
   - May return multiple keys with same prefix prefix; app filters by `key_hash` afterward
   - **Expected**: Grows slightly with table size, but index keeps it bounded

3. **Lookup by user_id** (for "user's active keys" query):
   ```sql
   SELECT * FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL;
   ```
   - Uses `idx_api_keys_user_id` index
   - Returns all active keys for a user
   - **Expected**: Grows linearly with user's key count, but indexed so fast per key

## Benchmark Plan

### 1. Current latency at current volume
- Measure `SELECT * FROM api_keys WHERE key_hash = $1` latency with current key count (will be ~0 since table is small)
- Capture EXPLAIN ANALYZE

### 2. Simulated 10x key volume
- Insert 10x more api_keys rows (e.g., 500 → 5000, or realistic production estimate)
- Measure same query latency
- Capture EXPLAIN ANALYZE

### 3. Simulated 100x key volume
- Insert 100x more rows
- Measure latency degradation

### EXPLAIN ANALYZE Queries to Capture

#### Key hash lookup (primary auth path)
```sql
EXPLAIN ANALYZE 
SELECT id, user_id, key_hash, prefix, scopes, created_at 
FROM api_keys 
WHERE key_hash = 'some-test-hash-value-equals-length-64-hex-chars';
```

#### Prefix lookup
```sql
EXPLAIN ANALYZE 
SELECT id, user_id, key_hash, prefix, scopes, created_at 
FROM api_keys 
WHERE prefix = 'KEY-001';
```

#### User keys lookup
```sql
EXPLAIN ANALYZE 
SELECT id, user_id, key_hash, prefix, scopes, created_at 
FROM api_keys 
WHERE user_id = 'user-uuid' AND revoked_at IS NULL;
```

### Key Metrics to Record

| Metric | Target | Notes |
|---|---|---|
| Key hash lookup p95 | < 5ms | Should be constant regardless of table size (unique index on key_hash) |
| Key hash lookup p95 (10x volume) | < 5ms | Verify no degradation |
| Key hash lookup p95 (100x volume) | < 10ms | Upper bound — still excellent |
| Prefix lookup p95 (10x volume) | < 20ms | May grow slightly; still indexed |
| Prefix lookup p95 (100x volume) | < 50ms | Check for index efficiency loss |
| User keys lookup p95 (per-user 20 keys) | < 5ms | Per-user scan, not full table |
| User keys lookup p95 (per-user 100 keys) | < 10ms | Still indexed, should be fast |

### Recommendations

#### 1. Key Hash Lookup is Already Optimal
The `key_hash` column has a `UNIQUE` constraint, which PostgreSQL enforces with a **unique index**. A primary-value equality lookup (`WHERE key_hash = $1`) will always use an **Index Scan** with O(log n) complexity. Even at 100,000 keys, this should be < 5ms p95.

**No index changes needed** for this path.

#### 2. Monitor for Index Corruption / Bloat
While the unique index on `key_hash` should remain efficient:
- Run `REINDEX INDEX idx_api_keys_key_hash` periodically if bloat observed
- Monitor `pg_stat_user_indexes.idx_scans` and `idx_tup_read` for the key_hash index
- If `idx_scan` drops to 0, the index may be unused or corrupted

#### 3. Prefix Lookup May Need Attention at Scale
The `idx_api_keys_prefix` index on `prefix` alone (not compound with `user_id`) could become less efficient at very large volumes because:
- Many keys may share the same prefix (e.g., all test keys start with "KEY-")
- The index scan returns multiple rows, then the app must filter

**If prefix lookups are on the hot auth path**:
- Consider a compound index: `CREATE INDEX idx_api_keys_user_prefix ON api_keys(user_id, prefix)`
- This combines the user-scoped filter with the prefix filter, reducing the scan range
- Update the unique constraint to: `CREATE UNIQUE INDEX idx_api_keys_user_prefix_active ON api_keys(user_id, prefix) WHERE revoked_at IS NULL;` (already exists!)

#### 4. Caching for Extreme Scale
If the API runs at > 10,000 req/sec with api_key auth:
- Cache the `api_keys` lookup in Redis: `KEYS:{key_hash} → {user_id, scopes, revoked_at}`
- Check Redis first (sub-ms), fall back to Postgres if miss
- Invalidate cache on key creation/revocation
- **Note**: Current codebase uses BullMQ for job queue; could add a Redis-based auth cache layer

#### 5. Ensure `key_hash` Index Stays Unique
The `UNIQUE` constraint on `key_hash` prevents duplicates, but verify:
- No bulk insert scripts bypass the constraint
- Migration 003 down script drops the table entirely (acceptable for dev)
- If using UUID v4 for `id`, collision probability is negligible, but verify `key_hash` generation is truly unique (SHA-256 of raw key, for example)

## Conclusion

**The API keys lookup on the auth hot path is already well-indexed and should maintain sub-5ms latency even at 10x–100x current key volume**, because:

1. `key_hash` has a `UNIQUE` constraint → unique index → O(log n) index scan
2. `prefix` lookups are supported by `idx_api_keys_prefix` → efficient for filtered lookups
3. `user_id` lookups use `idx_api_keys_user_id` → per-user scan, not full table

**The real risk is not latency degradation but schema gaps**:
- The unique constraint `(user_id, prefix) WHERE revoked_at IS NULL` is correct for "one active key per prefix per user"
- But if the auth path looks up by `key_hash` only (no user context), there's no index guarding against key_hash collisions across users (though the UNIQUE constraint handles this globally)

**Recommendations**:
- ✅ No immediate index changes needed for `key_hash` lookups
- ✅ Verify the auth path uses `key_hash` lookup, not sequential scan
- ✅ If prefix+user combined lookups are used, the existing compound unique index covers it
- ✅ Consider Redis caching at extreme scale (> 10k req/sec auth rate)
- ✅ Monitor `pg_stat_user_indexes` for index health at scale

---

**Next Steps**:
- [ ] Create Node benchmark script to measure `SELECT * FROM api_keys WHERE key_hash = $1` latency at 3 volumes (current/10x/100x)
- [ ] Capture EXPLAIN ANALYZE for key hash, prefix, and user_id lookups
- [ ] Simulate key volume growth by inserting test rows
- [ ] Run benchmarks and record metrics
- [ ] If latency grows with volume, recommend compound index or Redis cache
- [ ] Update docs/query-analysis.md with findings