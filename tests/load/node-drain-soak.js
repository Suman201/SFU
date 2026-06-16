import { check, sleep } from 'k6';
import http from 'k6/http';

export const options = {
  vus: 1,
  duration: __ENV.DURATION || '5m',
  thresholds: {
    checks: ['rate>0.99']
  }
};

const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
const applyDrain = __ENV.APPLY_NODE_DRAIN === 'true';

export default function () {
  const token = authToken();
  if (!token) {
    return;
  }

  const healthBefore = http.get(`${baseUrl}/api/v1/health`);
  check(healthBefore, {
    'health endpoint reachable before drain': (response) => response.status === 200
  });

  if (!applyDrain) {
    check(null, {
      'node drain soak mutation disabled': () => true
    });
    sleep(1);
    return;
  }

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const drain = http.post(`${baseUrl}/api/v1/media/node/drain`, JSON.stringify({ reason: 'k6-node-drain-soak' }), { headers });
  check(drain, {
    'node drain accepted': (response) => response.status === 201 || response.status === 200,
    'node marked draining': (response) => response.json('draining') === true,
    'node health is draining': (response) => response.json('health') === 'draining'
  });

  const healthDuringDrain = http.get(`${baseUrl}/api/v1/health`);
  check(healthDuringDrain, {
    'health endpoint reachable during drain': (response) => response.status === 200,
    'health exposes draining local node': (response) => response.body.includes('"draining":true')
  });

  const undrain = http.post(`${baseUrl}/api/v1/media/node/undrain`, null, { headers });
  check(undrain, {
    'node undrain accepted': (response) => response.status === 201 || response.status === 200,
    'node marked ready after undrain': (response) => response.json('draining') === false
  });

  sleep(1);
}

function authToken() {
  const email = `drain-soak-${__VU}-${Date.now()}@example.com`;
  const response = http.post(
    `${baseUrl}/api/v1/auth/register`,
    JSON.stringify({ displayName: `Drain Soak ${__VU}`, email, password: 'Password@12345' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(response, {
    'drain soak user registered': (res) => res.status === 201 || res.status === 200
  });
  return response.json('accessToken');
}
