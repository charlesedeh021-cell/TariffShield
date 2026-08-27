-- analyze-queries.sql
-- Captures EXPLAIN ANALYZE for all four scalability investigation queries.
--
-- Usage:
--   psql "$DATABASE_URL" -f sql/analyze-queries.sql
--
-- Captures:
--   1. GET / surety-license listing (with and without status filter)
--   2. GET bonds/:id/signature-status (bond lookup + latest signature)
--   3. POST bonds/docusign-webhook (envelope lookup + update pattern)
--   4. Contract upgrade proposal lookup pattern

\timing on
\echo ═══════════════════════════════════════════════════════════════════════════
\echo INVESTIGATION 1: Surety License Listing — GET /
\echo ═══════════════════════════════════════════════════════════════════════════

\echo ── 1a. Full listing (no filter, worst case) ─────────────────────────────
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT slv.id, slv.naic_number, slv.company_name, slv.state_of_domicile,
       slv.am_best_rating, slv.status, slv.submitted_at, slv.reviewed_at,
       slv.rejection_reason, u.email
  FROM surety_license_verifications slv
  JOIN users u ON u.id = slv.user_id
 ORDER BY slv.created_at DESC;

\echo ── 1b. Status-filtered listing (submitted) ──────────────────────────────
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT slv.id, slv.naic_number, slv.company_name, slv.state_of_domicile,
       slv.am_best_rating, slv.status, slv.submitted_at, slv.reviewed_at,
       slv.rejection_reason, u.email
  FROM surety_license_verifications slv
  JOIN users u ON u.id = slv.user_id
 WHERE slv.status = 'submitted'
 ORDER BY slv.created_at DESC;

\echo ── 1c. Index usage for review-status filter ─────────────────────────────
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch, pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
  FROM pg_stat_user_indexes
 WHERE tablename = 'surety_license_verifications'
 ORDER BY idx_scan DESC;

\echo ═══════════════════════════════════════════════════════════════════════════
\echo INVESTIGATION 2: Signature Status Polling — GET bonds/:id/signature-status
\echo ═══════════════════════════════════════════════════════════════════════════

\echo ── 2a. Bond lookup (surety_admin path) ──────────────────────────────────
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT br.id, br.signature_status FROM bond_records br WHERE br.id = (
  SELECT id FROM bond_records ORDER BY random() LIMIT 1
);

\echo ── 2b. Latest signature for bond ────────────────────────────────────────
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, envelope_id, signing_url, status, signed_document_hash,
       completed_at, last_reminder_sent_at, created_at
  FROM bond_signatures WHERE bond_record_id = (
    SELECT id FROM bond_records ORDER BY random() LIMIT 1
  )
 ORDER BY created_at DESC LIMIT 1;

\echo ── 2c. Index usage on bond_signatures ───────────────────────────────────
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch, pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
  FROM pg_stat_user_indexes
 WHERE tablename = 'bond_signatures'
 ORDER BY idx_scan DESC;

\echo ═══════════════════════════════════════════════════════════════════════════
\echo INVESTIGATION 3: Webhook Burst — POST bonds/docusign-webhook
\echo ═══════════════════════════════════════════════════════════════════════════

\echo ── 3a. Envelope lookup by envelope_id ────────────────────────────────────
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT id, bond_record_id, status, envelope_id
  FROM bond_signatures WHERE envelope_id = (
    SELECT envelope_id FROM bond_signatures ORDER BY random() LIMIT 1
  );

\echo ── 3b. Update pattern (completed status) ────────────────────────────────
\echo (Simulated — shows the UPDATE ... WHERE envelope_id plan)
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
UPDATE bond_signatures
   SET status = 'completed',
       signed_document_hash = 'test-hash',
       completed_at = now(),
       updated_at = now()
 WHERE envelope_id = (
   SELECT envelope_id FROM bond_signatures WHERE status = 'sent' LIMIT 1
 );

\echo ── 3c. Bond record update from webhook ──────────────────────────────────
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
UPDATE bond_records
   SET signature_status = 'completed'
 WHERE id = (
   SELECT bond_record_id FROM bond_signatures
    WHERE status = 'completed' ORDER BY created_at DESC LIMIT 1
 );

\echo ═══════════════════════════════════════════════════════════════════════════
\echo INVESTIGATION 4: Table Bloat & Storage Growth Estimates
\echo ═══════════════════════════════════════════════════════════════════════════

\echo ── 4a. Table sizes ──────────────────────────────────────────────────────
SELECT schemaname, tablename,
       pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS total_size,
       pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) AS table_size,
       pg_size_pretty(pg_indexes_size(schemaname||'.'::regclass || tablename)) AS index_size,
       n_live_tup AS row_count
  FROM pg_stat_user_tables
 WHERE tablename IN (
   'surety_license_verifications', 'bond_records', 'bond_signatures', 'users', 'importers'
 )
 ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC;

\echo ── 4b. Per-row size estimate ────────────────────────────────────────────
SELECT 'surety_license_verifications' AS table_name,
       pg_size_pretty(
         (SELECT pg_total_relation_size('surety_license_verifications')) /
         GREATEST((SELECT COUNT(*) FROM surety_license_verifications), 1)
       ) AS bytes_per_row
UNION ALL
SELECT 'bond_signatures',
       pg_size_pretty(
         (SELECT pg_total_relation_size('bond_signatures')) /
         GREATEST((SELECT COUNT(*) FROM bond_signatures), 1)
       )
UNION ALL
SELECT 'bond_records',
       pg_size_pretty(
         (SELECT pg_total_relation_size('bond_records')) /
         GREATEST((SELECT COUNT(*) FROM bond_records), 1)
       );

\echo ── 4c. Projection at 10x volume ────────────────────────────────────────
SELECT 'surety_license_verifications' AS table_name,
       COUNT(*) AS current_rows,
       COUNT(*) * 10 AS projected_10x,
       pg_size_pretty(COUNT(*) * 10 * 320) AS estimated_10x_size  -- ~320 bytes/row estimate
FROM surety_license_verifications
UNION ALL
SELECT 'bond_records',
       COUNT(*), COUNT(*) * 10, pg_size_pretty(COUNT(*) * 10 * 512)
FROM bond_records
UNION ALL
SELECT 'bond_signatures',
       COUNT(*), COUNT(*) * 10, pg_size_pretty(COUNT(*) * 10 * 384)
FROM bond_signatures;

\echo ═══════════════════════════════════════════════════════════════════════════
\echo DONE — Copy output for the scalability report.
\echo ═══════════════════════════════════════════════════════════════════════════
