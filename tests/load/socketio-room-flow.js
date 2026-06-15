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

  const socketUrl = baseUrl.replace('http', 'ws') + `/socket.io/?EIO=4&transport=websocket`;
  ws.connect(socketUrl, {}, (socket) => {
    socket.on('open', () => {
      socket.send('40/sfu,' + JSON.stringify({ token }));
    });
    socket.setTimeout(() => socket.close(), 5000);
  });
}
