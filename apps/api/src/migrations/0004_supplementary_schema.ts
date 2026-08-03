import { PoolClient } from 'pg';

// db.ts's rollback() runs a large "baseline schema ensure" block (as a
// safety net for the state a database is left in after a full migration
// rollback) that also contains schema this app depends on at runtime —
// ein_hash, audit_log, bonds, refresh_tokens, documents, and
// importer_documents_view — that was never added to the forward migration
// chain. Since db:migrate only ever runs the `up` direction in normal
// operation (see migrate() vs rollback() in db.ts), none of this schema
// was ever actually created outside of that rollback safety net, which
// nothing in CI or production exercises. This migration is the missing
// forward-path equivalent for the pieces genuinely not already covered by
// 0001-0003 (verified against every CREATE TABLE/INDEX/VIEW in db.ts's
// rollback() block — the rest duplicates 0001-0003 verbatim, harmlessly,
// via IF NOT EXISTS).
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    -- #243: ein_hash for PII-safe equality lookups. Partial unique index —
    -- NULL eins (optional field) never collide with each other or force
    -- uniqueness.
    ALTER TABLE importers ADD COLUMN IF NOT EXISTS ein_hash TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_importers_ein_hash ON importers(ein_hash) WHERE ein_hash IS NOT NULL;

    -- One-time backfill: compute ein_hash for any pre-existing row that has
    -- a plaintext ein but no hash yet. Safe to re-run — only touches rows
    -- still missing ein_hash.
    UPDATE importers
      SET ein_hash = encode(sha256(ein::bytea), 'hex')
      WHERE ein IS NOT NULL AND ein_hash IS NULL;

    -- #231: append-only audit log. db.ts's logAudit()/routes/admin.ts's
    -- GET /admin/audit-log already assume this exact shape
    -- (id, actor_user_id, action, target_id, payload, created_at).
    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_id UUID,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at DESC);

    -- Append-only: block UPDATE/DELETE via row-level security.
    ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS audit_log_no_update ON audit_log;
    CREATE POLICY audit_log_no_update ON audit_log FOR UPDATE USING (false);
    DROP POLICY IF EXISTS audit_log_no_delete ON audit_log;
    CREATE POLICY audit_log_no_delete ON audit_log FOR DELETE USING (false);

    -- #232: bonds — full bond lifecycle tracking (supersedes importers.bond_id).
    -- NOTE: importers.bond_id is deprecated and retained for backward
    -- compatibility. All new bond queries should use the bonds table instead.
    CREATE TABLE IF NOT EXISTS bonds (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      bond_number BIGINT NOT NULL,
      policy_type TEXT NOT NULL DEFAULT 'continuous' CHECK (policy_type IN ('continuous', 'single_entry', 'term')),
      coverage_amount NUMERIC(20, 2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'expired', 'cancelled', 'replaced')),
      issued_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      replaced_by_id UUID REFERENCES bonds(id),
      stellar_contract_address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bonds_bond_number ON bonds(bond_number);
    CREATE INDEX IF NOT EXISTS idx_bonds_importer_status ON bonds(importer_id, status, created_at DESC);

    -- Migrate existing importers.bond_id values into the bonds table.
    INSERT INTO bonds (importer_id, bond_number, policy_type, coverage_amount, status, issued_at, created_at)
    SELECT id, bond_id, 'continuous', 0, 'active', created_at, created_at
    FROM importers
    WHERE NOT EXISTS (SELECT 1 FROM bonds WHERE bond_number = importers.bond_id);

    -- #235: refresh_tokens — JWT refresh token flow with server-side revocation.
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      replaced_by_id UUID REFERENCES refresh_tokens(id),
      user_agent TEXT,
      ip_address INET,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash) WHERE revoked_at IS NULL;

    -- #234: documents — bond application PDF storage metadata (CBP Form 301,
    -- power of attorney, commercial invoices, KYC ID, etc). Stores a
    -- reference to the object-storage location, not the file bytes.
    -- Distinct from kyc_documents (#312), which is specifically compliance
    -- paperwork under its own retention/review workflow.
    CREATE TABLE IF NOT EXISTS documents (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      importer_id UUID NOT NULL REFERENCES importers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('cbp_301', 'power_of_attorney', 'commercial_invoice', 'kyc_id', 'other')),
      filename TEXT NOT NULL,
      url TEXT NOT NULL,
      mime_type TEXT,
      size_bytes BIGINT,
      uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_documents_importer_kind ON documents(importer_id, kind, created_at DESC);

    -- #244: importer_documents_view — joins importers with kyc_documents and
    -- kyc_status in a single query for the surety admin review workflow.
    -- A plain view, not materialized — reads always reflect current data,
    -- no refresh job needed (unlike importer_metrics_mv/importer_metrics).
    CREATE OR REPLACE VIEW importer_documents_view AS
    SELECT
      i.id AS importer_id,
      i.legal_name,
      i.ein_hash,
      i.bond_id,
      i.stellar_address,
      i.kyc_status,
      i.created_at AS importer_created_at,
      d.id AS document_id,
      d.document_type,
      d.review_status AS document_review_status,
      d.reviewer_id,
      d.reviewer_note,
      d.reviewed_at AS document_reviewed_at,
      d.scheduled_deletion_date AS document_scheduled_deletion_date,
      d.created_at AS document_created_at
    FROM importers i
    LEFT JOIN kyc_documents d
      ON d.importer_id = i.id AND d.deleted_at IS NULL
    WHERE i.deleted_at IS NULL;
  `);
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    DROP VIEW IF EXISTS importer_documents_view;
    DROP TABLE IF EXISTS documents CASCADE;
    DROP TABLE IF EXISTS refresh_tokens CASCADE;
    DROP TABLE IF EXISTS bonds CASCADE;
    DROP TABLE IF EXISTS audit_log CASCADE;
    DROP INDEX IF EXISTS idx_importers_ein_hash;
    ALTER TABLE importers DROP COLUMN IF EXISTS ein_hash;
  `);
}
