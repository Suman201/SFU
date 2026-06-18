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
const operationsToken = __ENV.OPERATIONS_TOKEN;

export default function () {
  const liveBefore = http.get(`${baseUrl}/health/live`);
  check(liveBefore, {
    'live endpoint reachable before drain': (response) => response.status === 200
  });

  const readyBefore = http.get(`${baseUrl}/health/ready`);
  check(readyBefore, {
    'ready endpoint reachable before drain': (response) => response.status === 200
  });

  if (!applyDrain) {
    check(null, {
      'node drain soak mutation disabled': () => true
    });
    sleep(1);
    return;
  }

  const token = authToken();
  if (!token) {
    return;
  }
  const headers = operationsHeaders(token);
  const drain = http.post(`${baseUrl}/api/v1/media/node/drain`, JSON.stringify({ reason: 'k6-node-drain-soak' }), { headers });
  check(drain, {
    'node drain accepted': (response) => response.status === 201 || response.status === 200,
    'node marked draining': (response) => response.json('draining') === true,
    'node health is draining': (response) => response.json('health') === 'draining'
  });

  const liveDuringDrain = http.get(`${baseUrl}/health/live`);
  check(liveDuringDrain, {
    'live endpoint reachable during drain': (response) => response.status === 200
  });

  const readyDuringDrain = http.get(`${baseUrl}/health/ready`);
  check(readyDuringDrain, {
    'ready endpoint rejects new traffic during drain': (response) => response.status >= 500
  });

  const nodeDiagnosticsDuringDrain = http.get(`${baseUrl}/api/v1/media/diagnostics/node`, { headers });
  check(nodeDiagnosticsDuringDrain, {
    'node diagnostics remain reachable during drain': (response) => response.status === 200,
    'node diagnostics expose traffic pause during drain': (response) => response.json('trafficReady') === false
  });

  const undrain = http.post(`${baseUrl}/api/v1/media/node/undrain`, null, { headers });
  check(undrain, {
    'node undrain accepted': (response) => response.status === 201 || response.status === 200,
    'node marked ready after undrain': (response) => response.json('draining') === false
  });

  const readyAfterUndrain = http.get(`${baseUrl}/health/ready`);
  check(readyAfterUndrain, {
    'ready endpoint recovers after undrain': (response) => response.status === 200
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

function operationsHeaders(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
  if (operationsToken) {
    headers['X-Operations-Token'] = operationsToken;
  }
  return headers;
}
