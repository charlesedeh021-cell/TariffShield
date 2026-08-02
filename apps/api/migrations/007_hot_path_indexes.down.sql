-- Migration 007 rollback: drop hot-path indexes (issue #257)
-- Down

DROP INDEX CONCURRENTLY IF EXISTS idx_tariff_uploads_importer_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_bonds_importer_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_contract_events_importer_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_importers_created_at;
DROP INDEX CONCURRENTLY IF EXISTS idx_importers_user_id;
