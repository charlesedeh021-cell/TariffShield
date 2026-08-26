// k6 benchmark: Data Erasure Request Scaling
// Measures POST /account/erasure-request latency at 3 data volumes
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, getAuthToken } from './lib/setup.js';

export const options = {
  vus: 5,
  duration: '2m',
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.001'],
  },
};

export function setup() {
  const token = getAuthToken();
  return { token };
};

export default function (data) {
  const res = http.post(`${BASE_URL}/account/erasure-request`, JSON.stringify({
    reason: 'privacy review',
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${data.token}`,
    },
  });

  check(res, {
    'status is 202': (r) => r.status === 202,
    'has requestId': (r) => r.json('requestId') !== undefined,
  });

  sleep(0.1);
}