// webhook-burst.js
// k6 load test for POST bonds/docusign-webhook (issue scalability investigation)
//
// Simulates a burst of DocuSign webhook callbacks arriving in a short window.
// Tests whether the endpoint can absorb 200+ deliveries without dropped writes.

import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL } from './lib/setup.js';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom metrics for webhook-specific analysis
const webhookSuccess = new Counter('webhook_success_count');
const webhookError = new Counter('webhook_error_count');
const webhookErrors = new Rate('webhook_error_rate');
const webhookDuration = new Trend('webhook_duration', true);

// Pre-generated envelope IDs (realistic: we'd create bonds first, then send webhooks)
const envelopes = new SharedArray('envelopes', function () {
  const ids = [];
  for (let i = 0; i < 500; i++) {
    ids.push(`STUB-ENV-TEST-${Date.now()}-${i}`);
  }
  return ids;
});

export const options = {
  scenarios: {
    // Burst: 200 VUs in 30 seconds (simulates DocuSign retry batch)
    burst: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: 50 },
        { duration: '10s', target: 200 },
        { duration: '5s', target: 200 },
        { duration: '10s', target: 0 },
      ],
      tags: { scenario: 'burst' },
    },
  },
  thresholds: {
    webhook_duration: ['p(95)<1000'],
    webhook_error_rate: ['rate<0.05'],
  },
};

export default function () {
  // Pick a random envelope ID
  const envelopeId = envelopes[Math.floor(Math.random() * envelopes.length)];

  const payload = JSON.stringify({
    envelopeId: envelopeId,
    status: 'completed',
    data: {
      envelopeSummary: {
        envelopeId: envelopeId,
        status: 'completed',
      },
    },
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      // In production, this would include the DocuSign HMAC signature
      // 'x-docusign-signature-1': hmac_signature,
    },
    tags: { name: 'POST /bonds/docusign-webhook' },
  };

  const res = http.post(`${BASE_URL}/bonds/docusign-webhook`, payload, params);

  webhookDuration.add(res.timings.duration);

  const success = res.status === 200;
  if (success) {
    webhookSuccess.add(1);
  } else {
    webhookError.add(1);
  }
  webhookErrors.add(!success);

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has received': (r) => r.json('received') === true,
    'response time OK': (r) => r.timings.duration < 2000,
  });
}
