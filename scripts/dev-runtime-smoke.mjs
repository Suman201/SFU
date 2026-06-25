const backendOrigin = process.env.BACKEND_ORIGIN ?? process.env.SFU_BACKEND_ORIGIN ?? 'http://127.0.0.1:3000';
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? 'http://127.0.0.1:4200';
const adminOrigin = process.env.ADMIN_ORIGIN ?? 'http://127.0.0.1:4300';

const checks = [
  { name: 'backend live health', url: `${backendOrigin}/health/live`, expectStatus: 200 },
  { name: 'backend ready health', url: `${backendOrigin}/health/ready`, expectStatus: 200 },
  { name: 'backend api protected route shape', url: `${backendOrigin}/api/v1/roles`, expectStatus: 401 },
  { name: 'backend socket.io handshake', url: `${backendOrigin}/socket.io/?EIO=4&transport=polling`, expectStatus: 200 },
  { name: 'frontend shell', url: `${frontendOrigin}/`, expectStatus: 200 },
  { name: 'frontend runtime env', url: `${frontendOrigin}/env.js`, expectStatus: 200 },
  { name: 'frontend login shell', url: `${frontendOrigin}/login`, expectStatus: 200 },
  { name: 'admin shell', url: `${adminOrigin}/`, expectStatus: 200 },
  { name: 'admin runtime env', url: `${adminOrigin}/env.js`, expectStatus: 200 },
  { name: 'admin dashboard shell', url: `${adminOrigin}/dashboard`, expectStatus: 200 }
];

const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 5000);
let failures = 0;

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

for (const check of checks) {
  try {
    const response = await fetchWithTimeout(check.url);
    if (response.status !== check.expectStatus) {
      failures += 1;
      console.error(`FAIL ${check.name}: expected ${check.expectStatus}, got ${response.status} (${check.url})`);
      continue;
    }
    console.log(`PASS ${check.name}: ${response.status}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${check.name}: ${error instanceof Error ? error.message : String(error)} (${check.url})`);
  }
}

if (failures > 0) {
  process.exit(1);
}
