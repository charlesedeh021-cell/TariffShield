#!/usr/bin/env bash
# run-scalability-tests.sh
# Orchestrates the full scalability investigation for all four issues.
#
# Prerequisites:
#   - Docker Compose stack running (docker compose up -d postgres)
#   - k6 installed (https://k6.io/docs/getting-started/installation/)
#   - psql available
#
# Usage:
#   SCALE=1  bash scripts/run-scalability-tests.sh   (baseline)
#   SCALE=10 bash scripts/run-scalability-tests.sh   (10x volume)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
SQL_DIR="$SCRIPT_DIR/sql"
SCALE="${SCALE:-1}"

mkdir -p "$RESULTS_DIR"

export API_BASE_URL="${API_BASE_URL:-http://localhost:3002}"
export DATABASE_URL="${DATABASE_URL:-postgres://tariffshield:tariffshield_dev_password@localhost:5443/tariffshield}"

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  TariffShield Scalability Investigation — Scale factor: ${SCALE}x    ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Seed test data ────────────────────────────────────────────────────
echo "═══ Step 1: Seeding test data at ${SCALE}x volume ═══"
SCALE="$SCALE" psql "$DATABASE_URL" -f "$SQL_DIR/seed-scalability-data.sql" 2>&1 | tee "$RESULTS_DIR/seed-${SCALE}x.log"
echo ""

# ── Step 2: Run EXPLAIN ANALYZE ─══════════════════════════════════════════════
echo "═══ Step 2: Running EXPLAIN ANALYZE ═══"
psql "$DATABASE_URL" -f "$SQL_DIR/analyze-queries.sql" 2>&1 | tee "$RESULTS_DIR/explain-analyze-${SCALE}x.log"
echo ""

# ── Step 3: Ensure API is running ─════════════════════════════════════════════
echo "═══ Step 3: Checking API availability ═══"
if ! curl -sf "$API_BASE_URL/health" > /dev/null 2>&1; then
  echo "WARNING: API not reachable at $API_BASE_URL. Starting via Docker Compose..."
  docker compose up -d api
  echo "Waiting for API to be ready..."
  for i in $(seq 1 30); do
    if curl -sf "$API_BASE_URL/health" > /dev/null 2>&1; then
      echo "API ready after ${i}s"
      break
    fi
    sleep 1
  done
fi
echo ""

# ── Step 4: Run k6 load tests ─════════════════════════════════════════════════
echo "═══ Step 4: Running k6 scalability tests ═══"

K6_SCRIPTS=(
  "surety-license-listing.js"
  "signature-status-polling.js"
  "webhook-burst.js"
)

overall_status=0
for script in "${K6_SCRIPTS[@]}"; do
  name="${script%.js}"
  echo "--- Running $script ---"
  if k6 run \
    --summary-export "$RESULTS_DIR/${name}-${SCALE}x.json" \
    "$SCRIPT_DIR/$script"; then
    echo "  ✓ $script passed"
  else
    echo "  ✗ $script exceeded thresholds"
    overall_status=1
  fi
  echo ""
done

# ── Step 5: Capture index usage snapshot ─══════════════════════════════════════
echo "═══ Step 5: Capturing index usage after load tests ═══"
psql "$DATABASE_URL" -c "
SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
  FROM pg_stat_user_indexes
 WHERE tablename IN ('surety_license_verifications','bond_records','bond_signatures','users','importers')
 ORDER BY tablename, idx_scan DESC;
" 2>&1 | tee "$RESULTS_DIR/index-usage-${SCALE}x.log"
echo ""

# ── Summary ─════════════════════════════════════════════════════════════════════
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  Results written to: $RESULTS_DIR/"
echo "║  Scale: ${SCALE}x | Overall status: $([ $overall_status -eq 0 ] && echo PASS || echo FAIL)"
echo "╚══════════════════════════════════════════════════════════════════╝"

exit $overall_status
