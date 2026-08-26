// k6 benchmark: Privacy Policy History Join Latency
// Measures GET /privacy-policy-history at 3 volumes
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, getAuthToken } from './lib/setup.js';

export const options = {
  vus: 5,
  duration: '2m',
  thresholds: {
    http_req_duration: ['p(95)<100'],
    http_req_failed: ['rate<0.001'],
  },
};

export function setup() {
  const token = getAuthToken();
  return { token };
};

export default function (data) {
  const res = http.get(`${BASE_URL}/privacy-policy-history`, {
    headers: {
      'Authorization': `Bearer ${data.token}`,
    },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has acceptances': (r) => r.json('acceptances') !== undefined,
  });

  sleep(0.1);
}