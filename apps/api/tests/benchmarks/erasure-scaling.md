# Data Erasure Request Scaling Investigation

**Issue**: Whether processing time for a single erasure request scales with the volume of an account's historical activity, and whether this risks request timeouts for long-lived accounts.

## Current Implementation (`apps/api/src/routes/erasure.ts:20-50`)

- POST `/account/erasure-request` creates a `data_erasure_requests` row via `createDataErasureRequest()` (db.ts:1153-1167)
- Response returns the request `id`, `request_id`, `status`, `requested_at`, and `sla_deadline`
- No background worker triggered within the request — processing is **synchronous** at the HTTP level
- The `affected_fields` default includes `['legal_name', 'ein', 'email']` — erasure likely cascades to related tables

## Tables Affected by Erasure (from schema analysis)

| Table | Foreign Key Reference | Cascade Behavior |
|---|---|---|
| `data_erasure_requests` | — | Primary insert |
| `users` | `importer_id REFERENCES importers(id) ON DELETE CASCADE` | User row deleted cascade |
| `importers` | `user_id REFERENCES users(id) ON DELETE CASCADE` | Importer row deleted cascade |
| `authentication_attempts` | `user_id REFERENCES users(id) ON DELETE CASCADE` | Auth attempts deleted |
| `bond_records` | `importer_id REFERENCES importers(id) ON DELETE CASCADE` | Bond records deleted |
| `tariff_uploads` | `importer_id REFERENCES importers(id) ON DELETE CASCADE` | Tariff uploads deleted |
| `contract_events` | `importer_id REFERENCES importers(id) ON DELETE CASCADE` | Events deleted |
| `bonds` | `importer_id REFERENCES importers(id) ON DELETE CASCADE` | Bonds deleted |
| `refresh_tokens` | `user_id REFERENCES users(id) ON DELETE CASCADE` | Refresh tokens deleted |
| `user_sessions` | `user_id REFERENCES users(id) ON DELETE CASCADE` | Sessions deleted |
| `documents` | `importer_id REFERENCES importers(id) ON DELETE CASCADE` | Documents deleted |
| `kyc_documents` | `importer_id REFERENCES importers(id) ON DELETE CASCADE` | KYC docs deleted |
| `compliance_flags` | `importer_id REFERENCES importers(id) ON DELETE CASCADE` | Flags deleted |
| `compliance_reports` | `surety_id REFERENCES users(id) ON DELETE CASCADE` | Reports deleted |
| `surety_license_verifications` | `user_id REFERENCES users(id) ON DELETE CASCADE` | License verified deleted |
| `privacy_policy_acceptances` | `user_id REFERENCES users(id) ON DELETE RESTRICT` | **RESTRICT** — prevents erasure if privacy acceptances exist |
| `privacy_policy_versions` | — | — |
| `tos_acceptances` | `user_id REFERENCES users(id) ON DELETE RESTRICT` | **RESTRICT** — prevents erasure if ToS acceptances exist |
| `data_erasure_requests` | `user_id REFERENCES users(id) ON DELETE CASCADE` | Request rows deleted |

## Benchmark Plan

### 1. Low-activity account (1–5 importer records)
- Seed 1 user with 1 importer, 3 kyc_documents, 2 bond_records
- Create 1 erasure request
- Measure total rows across all tables: ~20 rows
- Time: `POST /account/erasure-request` → fetch request status
- Expected: < 50ms total (insert + select)

### 2. Medium-activity account (20–50 importer records)
- Seed 1 user with 30 importers, associated kyc_documents, bond_records, tariff_uploads, contract_events
- Total related rows: ~200–500 across cascade tables
- Create erasure request, measure processing time
- Expected: < 100ms total

### 3. High-activity account (100+ importer records / long-lived)
- Seed 1 user with 100+ importers, full history of contract_events, tariff_uploads spanning years
- Total related rows: thousands across cascade tables
- Create erasure request, measure processing time
- **Risk**: If synchronous cascade deletes, timeouts possible at scale (Postgres `statement_timeout` default 10s, pool `connectionTimeoutMillis` 3s)

## EXPLAIN ANALYZE Queries to Capture

### Erasure request insert + select path
```sql
-- Insert
INSERT INTO data_erasure_requests (request_id, user_id, importer_id, sla_deadline, affected_fields)
VALUES ($1, $2, $3, $4, ARRAY['legal_name', 'ein', 'email'])
RETURNING id;

-- Fetch request
SELECT id, request_id, status, requested_at, sla_deadline FROM data_erasure_requests WHERE id = $1;

-- Cascade delete cost estimate (run on staging with realistic data)
EXPLAIN ANALYZE DELETE FROM users WHERE id = $1;
```

## Key Metrics to Record

| Metric | Target | Notes |
|---|---|---|
| Insert latency p95 | < 50ms | `data_erasure_requests` primary key insert |
| Select latency p95 | < 20ms | Primary key lookup on `data_erasure_requests` |
| Cascade delete p95 (50 rows) | < 200ms | If erasure triggers synchronous cascade |
| Cascade delete p95 (500+ rows) | < 500ms | Risk zone — may exceed request timeout |
| Pool waitingCount impact | < 5 concurrent | Monitor `pg_pool_waiting` during bulk erasure |

## Recommendations

### 1. Deferred / Background Erasure Processing (PRIORITY)
- **Current**: Erasure request creates a `pending` row and returns immediately — but if the API handler later polls `GET /account/erasure-request/:requestId` and the cascade hasn't completed, the user sees `pending` status indefinitely.
- **Fix**: Offload the cascade delete to a background job (BullMQ worker, similar to `tx-submit` queue in `queue.ts`). The API route should:
  1. Insert `data_erasure_requests` row with status `pending`
  2. Enqueue a `data-erasure` job to a BullMQ queue
  3. Return `request_id` with status `pending` and `sla_deadline`
  4. A worker process performs the cascade deletes (`users`, `importers`, `contract_events`, etc.) in transactions
  5. Update the request status to `completed`/`failed` when done

### 2. Staged Erasure (to avoid lock contention)
- Instead of deleting all cascade tables in one transaction:
  - Phase 1: Mark importer/user as `deleted_at` (soft delete)
  - Phase 2: Background job permanently removes blobs from S3, purges old contract events beyond retention
  - Phase 3: Finalize erasure request status

### 3. Index coverage verification
- Ensure `idx_data_erasure_requests_user` (`user_id, created_at DESC`) is used for polling queries
- Ensure `idx_data_erasure_requests_status` (`status, sla_deadline`) supports SLA deadline checks

### 4. SLA deadline awareness
- Current: `sla_deadline` set to 30 days from request (`db.ts:1158`)
- If background processing takes > 30 days, SLA is missed — monitor `processing_started_at` and `completed_at` fields (already in schema but not used in current route)

### 5. Timeout guard
- Postgres `statement_timeout` is 10s (db.ts:1210) — ensure cascade deletes for any single erasure request stay under this
- If they exceed 10s, either batch the deletes or move to background worker

## Conclusion

**Erasure request processing is currently synchronous within the HTTP request** — the `POST /account/erasure-request` endpoint inserts the row and returns immediately, but any subsequent query that touches the erased account's data will encounter cascade deletes. For accounts with high historical activity (thousands of contract_events, tariff_uploads, bond_records), the cascade delete could:

1. **Block the pool** — holding connections while deleting thousands of rows
2. **Exceed `statement_timeout`** — default 10s guard will cancel the query
3. **Cause request timeouts** — if the frontend polls and the DB is still processing cascade

**Recommendation**: Move erasure cascade processing to a background BullMQ worker. The API route should enqueue a `data-erasure` job and return `pending` status with an `sla_deadline`. A worker process handles the cascade deletes progressively, updating the request status when complete. This prevents synchronous request timeouts and allows progressive erasure across multiple transactions.

---

**Next Steps**:
- [ ] Create k6/Node benchmark script to measure insert + select latency at 3 data volumes
- [ ] Run EXPLAIN ANALYZE on cascade delete with 50 vs 500 related rows
- [ ] Design BullMQ `data-erasure` job pattern following existing `tx-submit` queue pattern
- [ ] Update `erasure.ts` route to enqueue background job instead of synchronous cascade