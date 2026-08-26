// signature-status-polling.js
// k6 load test for GET bonds/:id/signature-status (issue scalability investigation)
//
// Simulates many clients polling signature status concurrently during
// a high-volume signing period.

import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, registerTestImporter } from './lib/setup.js';

export const options = {
  scenarios: {
    // Baseline: 20 VUs polling every 3s for 1 minute
    baseline_poll: {
      executor: 'constant-arrival-rate',
      rate: 20,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 50,
      maxVUs: 200,
      tags: { scenario: 'baseline' },
    },
    // High volume: 100 VUs polling every 3s for 1 minute
    high_volume_poll: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '60s',
      startTime: '65s',
      preAllocatedVUs: 200,
      maxVUs: 500,
      tags: { scenario: 'high_volume' },
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  // Create an importer with bonds (realistic: bond has a signature in progress)
  const { token, importerId } = registerTestImporter();
  return { token, importerId };
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.token}` };

  // Poll the importer's signature status
  // In a real scenario, each VU would poll a different bond ID.
  // Here we use the test importer's bond (slight variation to avoid cache).
  const bondId = data.importerId;

  const res = http.get(`${BASE_URL}/bonds/${bondId}/signature-status`, {
    headers,
    tags: { name: 'GET /bonds/:id/signature-status' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has bondId': (r) => r.json('bondId') !== undefined,
    'has signatureStatus': (r) => r.json('signatureStatus') !== undefined,
    'response time OK': (r) => r.timings.duration < 500,
  });
}
