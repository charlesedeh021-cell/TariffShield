-- seed-scalability-data.sql
-- Seeds the database with scalable volumes of test data for performance testing.
--
-- Usage:
--   psql "$DATABASE_URL" -f sql/seed-scalability-data.sql -v scale=1    (baseline: ~500 submissions)
--   psql "$DATABASE_URL" -f sql/seed-scalability-data.sql -v scale=10   (10x: ~5000 submissions)
--   psql "$DATABASE_URL" -f sql/seed-scalability-data.sql -v scale=100  (100x: ~50000 submissions)
--
-- Drops existing test data first (users with @scalability-test.test email domain).

\set scale `echo ${SCALE:-1}`

BEGIN;

-- ── Cleanup previous test data ────────────────────────────────────────────────
DELETE FROM surety_license_verifications
 WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@scalability-test.test');
DELETE FROM bond_signatures
 WHERE bond_record_id IN (
   SELECT br.id FROM bond_records br
   JOIN importers i ON i.id = br.importer_id
   JOIN users u ON u.id = i.user_id
   WHERE u.email LIKE '%@scalability-test.test'
 );
DELETE FROM bond_records
 WHERE importer_id IN (
   SELECT i.id FROM importers i
   JOIN users u ON u.id = i.user_id
   WHERE u.email LIKE '%@scalability-test.test'
 );
DELETE FROM importers
 WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@scalability-test.test');
DELETE FROM users WHERE email LIKE '%@scalability-test.test';

-- ── Helper: generate random text ──────────────────────────────────────────────
-- (PostgreSQL doesn't have a built-in random string, but we can use md5)

-- ── Seed users ────────────────────────────────────────────────────────────────
-- Each "batch" creates 50 surety_admin users + 500 importer users.
-- At scale=1 we create 1 batch; at scale=10 we create 10 batches (5000 importers).

DO $$
DECLARE
  batch INT;
  user_count INT := 0;
  importer_count INT := 0;
  surety_count INT := 0;
  v_user_id UUID;
  v_importer_id UUID;
  v_bond_id BIGINT;
  v_status TEXT;
  v_submitted_at TIMESTAMPTZ;
  v_reviewed_at TIMESTAMPTZ;
  v_reviewer_id UUID;
  statuses TEXT[] := ARRAY['pending','submitted','submitted','submitted','verified','verified','rejected'];
  states TEXT[] := ARRAY['CA','TX','NY','FL','IL','PA','OH','GA','NC','MI','NJ','VA','WA','AZ','MA','TN','IN','MO','MD','WI','CO','MN','SC','AL','LA','KY','OR','OK','CT','UT','IA','NV','AR','MS','KS','NM','NE','ID','WV','HI','NH','ME','MT','RI','DE','SD','ND','AK','VT','WY','DC'];
BEGIN
  FOR batch IN 1..:scale LOOP
    -- Create surety_admin users (50 per batch)
    FOR i IN 1..50 LOOP
      surety_count := surety_count + 1;
      INSERT INTO users (id, email, password_hash, role, created_at)
      VALUES (
        gen_random_uuid(),
        'surety-' || surety_count || '-b' || batch || '@scalability-test.test',
        '$2b$10$dummyhashdummyhashdummyhashdummyhashdummyhash',
        'surety_admin',
        now() - (random() * interval '365 days')
      ) RETURNING id INTO v_user_id;

      -- Create a license verification record
      v_status := statuses[1 + (random() * 6)::int];
      v_submitted_at := CASE WHEN v_status IN ('submitted','verified','rejected')
                              THEN now() - (random() * interval '30 days') END;
      v_reviewed_at := CASE WHEN v_status IN ('verified','rejected')
                            THEN v_submitted_at + (random() * interval '7 days') END;

      -- Pick a random reviewer for reviewed records
      IF v_reviewed_at IS NOT NULL THEN
        SELECT id INTO v_reviewer_id FROM users
        WHERE role = 'surety_admin' AND email LIKE '%@scalability-test.test'
        ORDER BY random() LIMIT 1;
      ELSE
        v_reviewer_id := NULL;
      END IF;

      INSERT INTO surety_license_verifications (
        user_id, naic_number, company_name, state_of_domicile,
        am_best_rating, license_status_detail, status,
        submitted_at, reviewed_at, reviewer_id, rejection_reason, created_at
      ) VALUES (
        v_user_id,
        lpad((random() * 999999)::int::text, 6, '0'),
        'Test Surety Company ' || surety_count,
        states[1 + (random() * 50)::int],
        (ARRAY['A++','A+','A','A-','B++','B+','B'])[1 + (random() * 6)::int],
        'Active - ' || (random() * 100)::int || ' years',
        v_status,
        v_submitted_at,
        v_reviewed_at,
        v_reviewer_id,
        CASE WHEN v_status = 'rejected' THEN 'Failed verification' ELSE NULL END,
        now() - (random() * interval '365 days')
      );
    END LOOP;

    -- Create importer users (500 per batch)
    FOR i IN 1..500 LOOP
      importer_count := importer_count + 1;
      INSERT INTO users (id, email, password_hash, role, created_at)
      VALUES (
        gen_random_uuid(),
        'importer-' || importer_count || '-b' || batch || '@scalability-test.test',
        '$2b$10$dummyhashdummyhashdummyhashdummyhashdummyhash',
        'importer',
        now() - (random() * interval '365 days')
      ) RETURNING id INTO v_user_id;

      v_bond_id := 1000000 + importer_count + (batch - 1) * 500;

      INSERT INTO importers (
        user_id, legal_name, bond_id, stellar_address,
        collateral_balance, created_at
      ) VALUES (
        v_user_id,
        'Test Importer ' || importer_count,
        v_bond_id,
        'G' || md5(random()::text),
        (random() * 10000000000)::bigint,
        now() - (random() * interval '365 days')
      ) RETURNING id INTO v_importer_id;

      -- Create 1-3 bond records per importer
      FOR j IN 1..(1 + (random() * 2)::int) LOOP
        INSERT INTO bond_records (
          importer_id, bond_id, bond_type_code, principal_legal_name,
          principal_ein, surety_company_name, surety_fein,
          bond_amount, cbp_minimum_required, effective_date, expiry_date,
          requires_increase, signature_status, created_at
        ) VALUES (
          v_importer_id,
          v_bond_id + j,
          (ARRAY['01','02','03','04'])[1 + (random() * 3)::int],
          'Test Importer ' || importer_count,
          lpad((random() * 999999999)::int::text, 9, '0'),
          'Test Surety Co ' || (1 + (random() * 50)::int),
          lpad((random() * 999999999)::int::text, 9, '0'),
          (random() * 50000000000)::bigint,
          (random() * 10000000000)::bigint,
          CURRENT_DATE - (random() * interval '365 days'),
          CURRENT_DATE + (random() * interval '730 days'),
          random() > 0.9,
          (ARRAY['pending','sent','completed','completed','completed'])[1 + (random() * 4)::int],
          now() - (random() * interval '365 days')
        ) RETURNING id INTO v_importer_id;
      END LOOP;
    END LOOP;

    RAISE NOTICE 'Batch % seeded (users: %, importers: %)', batch, surety_count + importer_count, importer_count;
  END LOOP;

  RAISE NOTICE 'Total: % users, % importers', surety_count + importer_count, importer_count;
END $$;

COMMIT;

-- ── Summary ───────────────────────────────────────────────────────────────────
SELECT 'surety_license_verifications' AS table_name, COUNT(*) AS row_count
FROM surety_license_verifications WHERE user_id IN
  (SELECT id FROM users WHERE email LIKE '%@scalability-test.test')
UNION ALL
SELECT 'bond_records', COUNT(*) FROM bond_records WHERE importer_id IN
  (SELECT i.id FROM importers i JOIN users u ON u.id = i.user_id WHERE u.email LIKE '%@scalability-test.test')
UNION ALL
SELECT 'bond_signatures', COUNT(*) FROM bond_signatures WHERE bond_record_id IN
  (SELECT br.id FROM bond_records br JOIN importers i ON i.id = br.importer_id JOIN users u ON u.id = i.user_id WHERE u.email LIKE '%@scalability-test.test')
UNION ALL
SELECT 'users', COUNT(*) FROM users WHERE email LIKE '%@scalability-test.test'
UNION ALL
SELECT 'importers', COUNT(*) FROM importers WHERE user_id IN
  (SELECT id FROM users WHERE email LIKE '%@scalability-test.test');
