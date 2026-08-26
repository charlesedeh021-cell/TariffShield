// k6 benchmark: Mass ToS Re-Acceptance Burst
// Simulates concurrent accept-tos writes with same versionId
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, getAuthToken } from './lib/setup.js';

export const options = {
  vus: 50,
  duration: '2m',
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
  },
};

export function setup() {
  const token = getAuthToken();
  return { token };
};

export default function (data) {
  // All VUs use the same versionId to simulate burst after new ToS publish
  const res = http.post(`${BASE_URL}/accept-tos`, JSON.stringify({
    versionId: 'v1.0.0',
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${data.token}`,
    },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'accepted': (r) => r.json('accepted') === true,
  });

  sleep(0.05);
}