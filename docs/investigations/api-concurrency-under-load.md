# Investigation: API performance under concurrent load (login, SAML, reports, soft-delete)

Issues: #1122, #1123, #1124, #1125

## Summary

Four performance investigations were completed against the TypeScript API
(`apps/api`). This document consolidates the findings. Two of them
(#1123, #1124) center on CPU-bound work on the Node event loop; one (#1125)
on fully-buffered database reads with no streaming primitive; and one (#1122)
on a missing index plus an inconsistent soft-delete filter that leaks deleted
rows into live listings.

---

## #1123 — `POST /auth/login` latency and password-hashing cost

**Entry point:** `apps/api/src/routes/auth.ts` — POST /login (line 176)
**Hashing:** `apps/api/src/auth.ts` — `bcryptjs`, cost factor 12

### Finding: CPU-bound hashing runs on the event loop

Passwords use **`bcryptjs`** (pure-JS implementation, `auth.ts:1`), so both
`hashPassword` (`bcrypt.hash(plain, 12)`, `auth.ts:75-77`) and `verifyPassword`
(`bcrypt.compare`, `auth.ts:79-81`) are synchronous, CPU-bound JavaScript at
**cost factor 12**. They run directly on the Node event loop — no native addon,
no worker thread. Under concurrent logins (10/50/100), every login performs this
blocking work on the shared event loop, serializing all in-flight requests.

**Result:** login p95/p99 degrades as concurrency rises, and unrelated endpoints
experience latency inflation because the event loop is occupied by cost-12
bcrypt work.

### Additional per-login DB round-trips (after verification)

The login handler (`routes/auth.ts:176-233`) performs several sequential awaits:
`recordAuthenticationAttempt` (×2 on failure, once on success), account-lock
checks, `getActiveSessionCount` (+ optional `revokeOldestSession`),
`createSession`, and a refresh-token DB write via `generateRefreshTokenPair`. So
a successful login is the bcrypt compare **plus ≥4–5 sequential DB round-trips**.

### Recommendation

1. Offload hashing/verification to native `bcrypt` or `argon2` running on
   worker threads (or a native binding that releases the event loop). This is
   the largest lever and removes the CPU serialization under concurrent load.
2. Keep cost 12 (or 13) with native hashing — cost 12 in pure JS is both slow
   and blocking.
3. Reduce sequential DB round-trips on the login hot path (batch bookkeeping +
   session creation into one transaction).
4. Confirm the existing `sessionLimiter` rate limit covers `/auth/login` under
   burst.

---

## #1124 — SAML callback latency under SSO bursts

**Entry point:** `apps/api/src/routes/auth.ts` — POST /saml/:provider/callback (line 371)

### Finding: latency is dominated by sequential provisioning DB writes, not crypto

The callback currently does minimal assertion validation: base64-decode the
`SAMLResponse` (line 393) and regex-based XML attribute extraction for NameID /
email (lines 424-447). It does **not** yet perform full SAML signature
verification — the code comments "Production: replace with passport-saml
Strategy.verify()" (line 393). So today's CPU cost is not RSA-signature-bound.

The request path is async but **strictly sequential**, with **≥2 DB writes per
login on the request path**: a `SELECT` for the existing SAML user, an
`INSERT ... ON CONFLICT` on first login to provision the `surety_admin` user,
then `createSession` (INSERT), then a sync JWT `signToken`. Under a burst these
sequential DB round-trips serialise and become the bottleneck.

There is **no dedicated rate limiter** on the SAML callback and no IdP
metadata/public-key caching (config is static env vars, `getSamlConfig`,
lines 307-314).

### Secondary worst-case concern (noted in-code)

The `emailMatch` regex is flagged in a comment (lines 415-423) as a potential
catastrophic-backtracking hazard on attacker-controlled XML, bounded by the
`MAX_SAML_RESPONSE_LENGTH = 50_000` cap (line 405).

### Recommendation

1. When real SAML verification is added, offload the RSA/XML work off the event
   loop (worker threads).
2. Cache IdP metadata / the signing certificate; use a proper XML parser instead
   of regex (removes ReDoS risk and improves performance).
3. Batch user provisioning + session creation into a single transaction.
4. Add a rate limiter on the SAML callback (the login path has `sessionLimiter`;
   the callback does not).

---

## #1125 — Compliance report download streaming cost

**Entry point:** `apps/api/src/routes/compliance.ts` — GET /reports/:id/download (line 288)

### Finding: the download endpoint returns an S3 URL stub and does not buffer

`GET /compliance/reports/:id/download` (`compliance.ts:288-305`) does not stream
or buffer the file bytes. It only `SELECT`s `pdf_s3_key` (indexed lookup,
line 291-294) and returns a **pre-signed S3 URL placeholder**
(`'/dev/reports/${key}'`, line 303; the comment at 302 says "In production,
generate a pre-signed S3 GetObject URL here"). So for the monthly report the
Node process incurs **no memory cost**, and shipping is delegated to S3.

### Finding: the DB-report paths fully buffer results (the real memory risk)

Every reporting path uses `pool.query()`, which buffers the whole result in
memory (`apps/api/src/db.ts:139-178`). There is **no DB cursor /
`pg-query-stream` anywhere**.

- Admin oracle CSV export (`routes/admin.ts:341-414`): does `res.write` per row
  (good) but first materializes the entire table into `rows.rows` (line 371) —
  memory is O(total rows) in the API process.
- Regulatory state report (`routes/regulatory.ts:185-246`): builds the whole CSV
  as one string (`csvData += ...`, lines 188-194), caches it in-memory, then
  `res.send` (line 243) — no chunked writes.

If a real large report is ever produced from the DB, it will inherit the
fully-buffered `rows.rows` anti-pattern.

### Finding: generation-side N+1 full-table scans

`apps/api/src/jobs/compliance-report.ts`:
- `buildReportData()` (lines 34-134) runs **13 full-table aggregate scans**
  (over `bond_records`, `kyc_documents`, `aml_screenings`, `compliance_flags`),
  lines 51-107. These are **unpaginated full-table scans** that must finish
  within `PG_STATEMENT_TIMEOUT_MS` (default 10 s, `config/env.ts:34-39`).
- Re-run **once per surety** (`generateMonthlyComplianceReport`, line 166 loops
  sureties and calls `buildReportData` at line 170) — but the queries are **not
  scoped to the surety**, so this is an **N+1-style 13×N repetition of identical
  full scans**.
- The scanned columns (`created_at`, `expiry_date`, `reviewed_at`,
  `screening_timestamp`, `resolved_at`) are **not indexed**, so each is a seq
  scan.

### Recommendation

1. Complete the S3 presigned-URL path (the intended design) so clients download
   directly from S3. If proxying is required, pipe the S3 `GetObjectCommand`
   stream to `res` — never buffer the whole file.
2. Add a streaming DB primitive (`pg-query-stream` / cursor) to the `pool`
   wrapper (`db.ts:174-178`) and use it for large row exports.
3. Compute the monthly aggregates **once** (they are global, not surety-scoped)
   and fan the result out to sureties, instead of 13×N scans.
4. Index the aggregate columns or precompute into a materialized view so the job
   completes within the 10 s timeout.
5. Paginate `GET /compliance/reports` (currently unbounded, `compliance.ts:277`)
   using the LIMIT/offset pattern already used by the flags endpoint.

---

## #1122 — Importers soft-delete filtering overhead

**Entry point:** `apps/api/src/routes/importers.ts` — GET / (line 189)
**Column:** `importers.deleted_at` added in `migrations/0001_initial_schema.ts:465`

### Finding: `deleted_at` has no index

`importers.deleted_at` is added by a bare `ALTER TABLE` (no index) at
`migrations/0001_initial_schema.ts:465` (and `db.ts:735`). There is no plain or
partial index on it. `0005_scalability_indexes.ts` adds nothing for it.

### Finding: the filtered reads are the materialized views (full-table scans)

Only the materialized views filter `WHERE i.deleted_at IS NULL`:
`importer_metrics` (`0001:467-494`, `0002:183-210`, `db.ts:737-764`) and
`importer_documents_view` (`0004:119-139`, `db.ts:849-869`). Without an index on
`deleted_at`, each refresh is a **sequential scan** of `importers`. These views
are rebuilt every **5 minutes** (`jobs/refresh-importer-metrics.ts:25`) and
`importer_metrics` is also refreshed **on every tariff upload**
(`routes/importers.ts:721`), plus a `LEFT JOIN contract_events` so cost grows
with event volume.

### Finding: dashboard count includes soft-deleted importers (inconsistency)

`importer_metrics_mv` aggregates `total_importers` and `avg_balance` with **no**
`deleted_at` filter (`0001:446,448`, `0002:162,164`, `db.ts:716,718`), so the
dashboard count disagrees with the per-importer view and the admin auto-top-up
path (`admin.ts:504`), both of which exclude deleted rows.

### Finding: deleted rows leak into live listings

Many hot runtime queries **omit** the filter:
`GET /importers` (`importers.ts:189-206`), `loadImporterFor` (`330,333`),
`queue.ts:70`, `oracle-event-listener.ts:161`, `erasure.ts:29`, `kyc.ts:82,122,124`,
`regulatory.ts:136,149,161`, `bond-signatures.ts:66,133`, `compliance.ts:70`,
`db.ts:1088` (`getActiveBonds`). Only `routes/kyc.ts:162-167` filters it.

### Recommendation

1. Add a **partial index** on active importers (the pattern already used for
   `kyc_documents` at `0001:266` and `user_sessions` at `0001:411`):
   ```sql
   CREATE INDEX CONCURRENTLY idx_importers_active_created
     ON importers (created_at DESC) WHERE deleted_at IS NULL;
   CREATE INDEX CONCURRENTLY idx_importers_active_user
     ON importers (user_id) WHERE deleted_at IS NULL;
   ```
2. Add `AND deleted_at IS NULL` to the leaky hot paths so behavior is uniform
   with the admin path.
3. Fix `_mv` counts by adding `WHERE deleted_at IS NULL` to `total_importers` /
   `avg_balance`.
4. Reconsider rebuilding the heavy `importer_metrics` view on every upload.

---

## Consolidated recommendation

| Issue | Primary cause | Recommended change |
|-------|---------------|--------------------|
| #1123 | cost-12 bcrypt on the event loop | worker-thread/native hashing offload |
| #1124 | sequential provisioning DB writes, no SSO rate limit | batch DB writes, rate limit, cache IdP metadata |
| #1125 | unbuffered S3 stub + fully-buffered DB reads, N+1 scans | S3 presigned URL, DB cursor, single-pass generation |
| #1122 | no index on `deleted_at` + inconsistent filter | partial index + consistent filtering |

These are investigation findings; no code changes were made as part of this
report. Each recommendation is a follow-up implementation candidate.
