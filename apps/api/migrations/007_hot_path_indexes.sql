-- Migration 007: Missing indexes on hot-path queries in routes/importers.ts (issue #257)
-- Up
--
-- Analysis identified five index gaps causing sequential scans on the most
-- frequently hit query paths at production data volumes:
--
--   Query                              Missing index
--   ─────────────────────────────────  ──────────────────────────────────────────
--   importers WHERE user_id = $1       importers.user_id
--   importers ORDER BY created_at DESC importers.created_at DESC
--   contract_events WHERE importer_id  contract_events(importer_id, created_at, id)
--     + cursor keyset pagination
--   bonds WHERE importer_id ORDER BY   bonds(importer_id, created_at DESC)
--     created_at DESC
--   tariff_uploads WHERE importer_id   tariff_uploads(importer_id, created_at DESC)
--     ORDER BY created_at DESC LIMIT 1
--
-- All indexes use CONCURRENTLY to avoid table-level locks in production.
-- See docs/query-analysis.md for full EXPLAIN ANALYZE output and cost table.

-- importers.user_id: supports both the "does this user already have an importer?"
-- existence check (POST /) and the per-user importer list (GET / non-admin path).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_importers_user_id
  ON importers(user_id);

-- importers.created_at DESC: supports the surety-admin list (GET /) which orders
-- all importers by creation time descending without a WHERE filter.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_importers_created_at
  ON importers(created_at DESC);

-- contract_events(importer_id, created_at DESC, id DESC): covers both the initial
-- event-history fetch and the cursor-keyset continuation clause
-- `(created_at, id) < ($2::timestamptz, $3::uuid)` used in GET /:id/events.
-- The compound index allows the planner to satisfy ORDER BY created_at DESC, id DESC
-- via an Index Scan rather than a sequential scan + sort.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contract_events_importer_created_at
  ON contract_events(importer_id, created_at DESC, id DESC);

-- bonds(importer_id, created_at DESC): supports GET /:id/bonds which fetches the
-- full bond history for an importer ordered by created_at DESC.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bonds_importer_created_at
  ON bonds(importer_id, created_at DESC);

-- tariff_uploads(importer_id, created_at DESC): supports POST /:id/verify-oracle-data
-- which fetches the latest tariff upload for an importer, with and without an
-- as_of_date filter, using ORDER BY created_at DESC LIMIT 1.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tariff_uploads_importer_created_at
  ON tariff_uploads(importer_id, created_at DESC);
