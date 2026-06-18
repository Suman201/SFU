import { check, sleep } from 'k6';
import http from 'k6/http';
import ws from 'k6/ws';

export const options = {
  vus: 10,
  duration: '1m',
  thresholds: {
    checks: ['rate>0.95']
  }
};

const baseUrl = __ENV.BASE_URL || 'http://localhost:3000';
const operationsToken = __ENV.OPERATIONS_TOKEN;

export default function () {
  const email = `load-${__VU}-${Date.now()}@example.com`;
  const auth = http.post(
    `${baseUrl}/api/v1/auth/register`,
    JSON.stringify({ displayName: `VU ${__VU}`, email, password: 'Password@12345' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  check(auth, {
    'registered': (response) => response.status === 201 || response.status === 200 || response.status === 409
  });
  sleep(1);

  const token = auth.json('accessToken');
  if (!token) {
    return;
  }

  const metrics = http.get(`${baseUrl}/metrics`, { headers: metricsHeaders(token) });
  check(metrics, {
    'quality metrics registered': (response) =>
      response.status === 200 &&
      response.body.includes('sfu_consumer_quality_score') &&
      response.body.includes('sfu_producer_quality_score') &&
      response.body.includes('sfu_room_quality_score')
  });
  check(metrics, {
    'worker hardening metrics registered': (response) =>
      response.status === 200 &&
      response.body.includes('sfu_media_worker_capacity_score') &&
      response.body.includes('sfu_media_worker_draining') &&
      response.body.includes('sfu_media_worker_overloaded') &&
      response.body.includes('sfu_media_worker_room_failures_total') &&
      response.body.includes('sfu_room_admission_rejections_total')
  });
  check(metrics, {
    'cluster ownership metrics registered': (response) =>
      response.status === 200 &&
      response.body.includes('sfu_cluster_registered_nodes') &&
      response.body.includes('sfu_cluster_owned_rooms') &&
      response.body.includes('sfu_room_owner_redirects_total') &&
      response.body.includes('sfu_room_ownership_claims_total')
  });

  const socketUrl = baseUrl.replace('http', 'ws') + `/socket.io/?EIO=4&transport=websocket`;
  ws.connect(socketUrl, {}, (socket) => {
    socket.on('open', () => {
      socket.send('40/sfu,' + JSON.stringify({ token }));
    });
    socket.setTimeout(() => socket.close(), 5000);
  });
}

function metricsHeaders(token) {
  const headers = { Authorization: `Bearer ${token}` };
  if (operationsToken) {
    headers['X-Operations-Token'] = operationsToken;
  }
  return headers;
}
