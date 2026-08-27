#!/usr/bin/env tsx
/**
 * scripts/e2e.ts
 *
 * Happy-path end-to-end verification flow as documented in the README
 * "Verification flow" section. Exercises the full seven-step path against
 * a running API instance (default: http://localhost:3002).
 *
 * Steps:
 *   1. Health check   — GET  /health
 *   2. Signup         — POST /auth/signup
 *   3. Login          — POST /auth/login
 *   4. Register importer — POST /importers
 *   5. Deposit collateral + reserve — POST /importers/:id/deposit
 *   6. Upload tariff CSV (creates shortfall) — POST /importers/:id/tariff-csv
 *   7. Trigger auto_top_up — POST /importers/:id/auto-top-up
 *
 * Usage:
 *   npm run e2e
 *   npm run e2e -- --base-url http://localhost:3002
 *   npm run e2e -- --base-url https://api.example.com --timeout 30000
 *
 * Flags:
 *   --base-url <url>   Base URL of the API (default: http://localhost:3002)
 *   --timeout  <ms>    Per-request timeout in milliseconds (default: 15000)
 *
 * Exit codes:
 *   0  All steps passed
 *   1  One or more steps failed
 */

import { Command } from "commander";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const program = new Command();
program
  .name("e2e")
  .description("Happy-path end-to-end verification for the TariffShield API")
  .version("1.0.0")
  .option("--base-url <url>", "API base URL", "http://localhost:3002")
  .option("--timeout <ms>", "Per-request timeout in milliseconds", "15000")
  .parse(process.argv);

const opts = program.opts<{ baseUrl: string; timeout: string }>();
const BASE_URL = opts.baseUrl.replace(/\/$/, "");
const TIMEOUT_MS = parseInt(opts.timeout, 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let stepIndex = 0;
let failures = 0;

function stepLabel(name: string): string {
  stepIndex++;
  return `[e2e] Step ${stepIndex}: ${name}`;
}

async function request(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (opts.token) {
      headers["Authorization"] = `Bearer ${opts.token}`;
    }

    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }

    return { status: res.status, body };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Request timed out after ${TIMEOUT_MS}ms: ${method} ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function pass(label: string, detail?: string): void {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label: string, detail: string): never {
  console.error(`  ✗ ${label} — ${detail}`);
  failures++;
  // Exit immediately so subsequent steps don't run against broken state
  process.exit(1);
}

function assertStatus(
  label: string,
  actual: number,
  expected: number,
  body: unknown,
): void {
  if (actual !== expected) {
    fail(
      label,
      `expected HTTP ${expected}, got ${actual}. Body: ${JSON.stringify(body)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// E2E steps
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n[e2e] Running against: ${BASE_URL}\n`);

  // ── Step 1: Health check ────────────────────────────────────────────────
  {
    const label = stepLabel("Health check");
    console.log(label);
    let res: { status: number; body: unknown };
    try {
      res = await request("GET", "/health");
    } catch (err: any) {
      fail(label, `Could not reach API — is it running? (${err.message})`);
    }
    assertStatus(label, res.status, 200, res.body);
    pass(label, `status ${res.status}`);
  }

  // ── Step 2: Signup ──────────────────────────────────────────────────────
  const timestamp = Date.now();
  const testEmail = `e2e-${timestamp}@tariffshield.test`;
  const testPassword = `E2ePass-${timestamp}!`;

  {
    const label = stepLabel("Signup");
    console.log(label);
    const res = await request("POST", "/auth/signup", {
      body: { email: testEmail, password: testPassword },
    });
    assertStatus(label, res.status, 201, res.body);
    pass(label, `user created (${testEmail})`);
  }

  // ── Step 3: Login ───────────────────────────────────────────────────────
  let token = "";
  {
    const label = stepLabel("Login");
    console.log(label);
    const res = await request("POST", "/auth/login", {
      body: { email: testEmail, password: testPassword },
    });
    assertStatus(label, res.status, 200, res.body);
    token = (res.body as any)?.token ?? (res.body as any)?.accessToken ?? "";
    if (!token) {
      fail(label, `No token in login response: ${JSON.stringify(res.body)}`);
    }
    pass(label, "JWT received");
  }

  // ── Step 4: Register importer ───────────────────────────────────────────
  let importerId = "";
  {
    const label = stepLabel("Register importer");
    console.log(label);
    const res = await request("POST", "/importers", {
      token,
      body: {
        companyName: `E2E Corp ${timestamp}`,
        ein: `${timestamp}`.slice(-9).padStart(9, "0"),
        annualDutyObligation: 1_000_000,
      },
    });
    // 201 Created or 200 OK depending on implementation
    if (res.status !== 201 && res.status !== 200) {
      fail(label, `expected 200/201, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
    }
    importerId =
      (res.body as any)?.id ??
      (res.body as any)?.importerId ??
      (res.body as any)?.data?.id ??
      "";
    if (!importerId) {
      fail(label, `No importer ID in response: ${JSON.stringify(res.body)}`);
    }
    pass(label, `importer ${importerId} created`);
  }

  // ── Step 5: Deposit collateral + reserve ────────────────────────────────
  {
    const label = stepLabel("Deposit collateral (30 XLM) + reserve (100 XLM)");
    console.log(label);
    const res = await request("POST", `/importers/${importerId}/deposit`, {
      token,
      body: {
        collateralAmount: 30_000_000, // 30 XLM in stroops
        reserveAmount: 100_000_000,   // 100 XLM in stroops
      },
    });
    if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
      fail(label, `expected 200/201/202, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
    }
    pass(label, `deposit accepted (status ${res.status})`);
  }

  // ── Step 6: Upload tariff CSV ────────────────────────────────────────────
  {
    const label = stepLabel("Upload tariff CSV (creates shortfall)");
    console.log(label);
    // Minimal CSV: annual duty that requires > 30 XLM collateral
    // required_collateral = annual_duty × 10% × 50% → 2_000_000_000 × 0.1 × 0.5 = 100_000_000 stroops
    const csvContent = [
      "hts_code,annual_duty_usd,duty_rate",
      "8471.30.0100,2000000,0.25",
    ].join("\n");

    // Use multipart/form-data only if the endpoint expects it;
    // fall back to JSON with a `csv` field which some APIs accept.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: { status: number; body: unknown };
    try {
      const formData = new FormData();
      formData.append("file", new Blob([csvContent], { type: "text/csv" }), "tariff.csv");

      const fetchRes = await fetch(`${BASE_URL}/importers/${importerId}/tariff-csv`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        body: formData,
        signal: controller.signal,
      });
      let body: unknown;
      try { body = await fetchRes.json(); } catch { body = null; }
      res = { status: fetchRes.status, body };
    } catch (err: any) {
      if (err?.name === "AbortError") {
        fail(label, `Request timed out after ${TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
      fail(label, `expected 200/201/202, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
    }
    pass(label, `CSV accepted (status ${res.status})`);
  }

  // ── Step 7: auto_top_up ──────────────────────────────────────────────────
  {
    const label = stepLabel("auto_top_up (move shortfall from reserve to collateral)");
    console.log(label);
    const res = await request("POST", `/importers/${importerId}/auto-top-up`, {
      token,
    });
    if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
      fail(label, `expected 200/201/202, got ${res.status}. Body: ${JSON.stringify(res.body)}`);
    }
    pass(label, `auto_top_up accepted (status ${res.status})`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n[e2e] All ${stepIndex} steps passed.\n`);
}

main().catch((err: unknown) => {
  console.error("\n[e2e] Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
