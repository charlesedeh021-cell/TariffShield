// surety-license-listing.js
// k6 load test for GET /surety-license (issue scalability investigation)
//
// Simulates admin polling the listing endpoint as submission volume grows.
// At 10x volume, the listing query returns 5000+ rows without LIMIT.

import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, registerUser } from './lib/setup.js';

export const options = {
  scenarios: {
    // Baseline: 20 VUs for 30s
    baseline: {
      executor: 'constant-vus',
      vus: 20,
      duration: '30s',
      tags: { scenario: 'baseline' },
    },
    // Spike: 100 VUs for 30s (simulates admin team + automated cron)
    spike: {
      executor: 'constant-vus',
      vus: 100,
      duration: '30s',
      startTime: '35s',
      tags: { scenario: 'spike' },
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  // Register a surety_admin for auth
  const { token } = registerUser('surety_admin');
  return { token };
}

export default function (data) {
  const headers = { Authorization: `Bearer ${data.token}` };

  // 70% of requests use status filter (realistic admin behavior)
  const useFilter = Math.random() < 0.7;
  const url = useFilter
    ? `${BASE_URL}/surety-license?status=submitted`
    : `${BASE_URL}/surety-license`;

  const res = http.get(url, { headers, tags: { name: useFilter ? 'GET /surety-license?status=submitted' : 'GET /surety-license' } });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has verifications array': (r) => Array.isArray(r.json('verifications')),
    'response time OK': (r) => r.timings.duration < 1000,
  });
}
