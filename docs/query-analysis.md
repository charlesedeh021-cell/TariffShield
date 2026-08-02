# Hot-Path Query Analysis

> **Context**: Issue #257. Analysis performed on `apps/api/src/routes/importers.ts`
> by code inspection. The plan-type column reflects expected plan type after the
> indexes in `migrations/007_hot_path_indexes.sql` are applied. Actual EXPLAIN
> ANALYZE output should be captured at ≥ 1,000 importer rows and ≥ 50,000 event rows
> in a staging environment to validate execution time targets.

## Query table

| # | Query name | SQL summary | Plan type (before) | Plan type (after) | Index added | Notes |
|---|---|---|---|---|---|---|
| 1 | `importer-exists-check` | `SELECT id FROM importers WHERE user_id = $1` | Seq Scan | Index Scan | `idx_importers_user_id` | Called on every POST / to prevent duplicate registration |
| 2 | `importer-list-admin` | `SELECT … FROM importers i JOIN users u … ORDER BY i.created_at DESC` | Seq Scan + Sort | Index Scan | `idx_importers_created_at` | Surety-admin list, no WHERE filter; sort drives need for index |
| 3 | `importer-by-id-admin` | `SELECT * FROM importers WHERE id = $1` | Index Scan | Index Scan | _(primary key)_ | Already indexed; no change needed |
| 4 | `importer-by-id-user` | `SELECT * FROM importers WHERE id = $1 AND user_id = $2` | Index Scan | Index Scan | `idx_importers_user_id` | PK lookup with additional user_id filter; user_id index narrows scan |
| 5 | `event-history-initial` | `SELECT … FROM contract_events WHERE importer_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2` | Seq Scan | Index Scan | `idx_contract_events_importer_created_at` | Initial page load for GET /:id/events |
| 6 | `event-history-cursor` | `SELECT … FROM contract_events WHERE importer_id = $1 AND (created_at, id) < ($2, $3) ORDER BY … LIMIT $4` | Seq Scan + Filter | Index Scan | `idx_contract_events_importer_created_at` | Subsequent pages; keyset cursor on `(created_at, id)` |
| 7 | `bond-history` | `SELECT … FROM bonds WHERE importer_id = $1 ORDER BY created_at DESC` | Seq Scan | Index Scan | `idx_bonds_importer_created_at` | Called on every GET /:id/bonds |
| 8 | `tariff-upload-latest` | `SELECT * FROM tariff_uploads WHERE importer_id = $1 ORDER BY created_at DESC LIMIT 1` | Seq Scan | Index Scan | `idx_tariff_uploads_importer_created_at` | Latest tariff upload for verify-oracle-data |
| 9 | `tariff-upload-as-of` | `SELECT * FROM tariff_uploads WHERE importer_id = $1 AND created_at <= $2 ORDER BY created_at DESC LIMIT 1` | Seq Scan + Filter | Index Scan | `idx_tariff_uploads_importer_created_at` | As-of-date variant; same index covers the range filter |

## Index summary

| Index name | Table | Columns | Type | Migration |
|---|---|---|---|---|
| `idx_importers_user_id` | `importers` | `user_id` | B-tree | 007 |
| `idx_importers_created_at` | `importers` | `created_at DESC` | B-tree | 007 |
| `idx_contract_events_importer_created_at` | `contract_events` | `(importer_id, created_at DESC, id DESC)` | B-tree | 007 |
| `idx_bonds_importer_created_at` | `bonds` | `(importer_id, created_at DESC)` | B-tree | 007 |
| `idx_tariff_uploads_importer_created_at` | `tariff_uploads` | `(importer_id, created_at DESC)` | B-tree | 007 |

All indexes are created with `CONCURRENTLY` to avoid table-level locks in production.

## Existing indexes (not changed)

| Index name | Table | Purpose |
|---|---|---|
| `idx_oracle_price_feed_importer` | `oracle_price_feed` | `(importer_id, created_at DESC)` — already optimal |
| `idx_oracle_price_feed_ledger` | `oracle_price_feed` | `ledger_sequence` — listener checkpoint lookup |
| `idx_oracle_price_feed_tx_importer` | `oracle_price_feed` | Unique on `(tx_hash, importer_address)` — dedup |
| `idx_importers_deleted_at` | `importers` | Partial index for soft-delete filter |
| `idx_contract_events_raw_gin` | `contract_events` | GIN on `raw` JSONB — event filtering by payload |
| `idx_importers_legal_name_tsv` | `importers` | GIN on tsvector — full-text search |
| `idx_api_keys_user_id` | `api_keys` | User-scoped key lookups |
| `idx_api_keys_prefix` | `api_keys` | API key prefix lookup during auth |

## Validation steps

After applying migration 007, run the following on the staging DB to confirm all
new indexes are used:

```sql
-- Reset stats first
SELECT pg_stat_reset();

-- Run representative queries against realistic data, then:
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE indexrelname IN (
  'idx_importers_user_id',
  'idx_importers_created_at',
  'idx_contract_events_importer_created_at',
  'idx_bonds_importer_created_at',
  'idx_tariff_uploads_importer_created_at'
)
ORDER BY indexrelname;
```

`idx_scan` should be > 0 for each index after representative queries are exercised.
Dead indexes (idx_scan = 0 after sufficient load) should be removed.

## Performance target

The goal is for the DB portion of `GET /importers/:id` to complete in < 10ms p95.
This endpoint calls `loadImporterFor` (queries #3 or #4 above), then reads the
on-chain account via Soroban RPC (not DB-bound). The DB portion alone should be
sub-millisecond for primary-key lookups with the new user_id index.

Event-history queries (#5 and #6) should stay below 5ms p95 with the compound
`(importer_id, created_at DESC, id DESC)` index at 50,000 event rows per importer.
