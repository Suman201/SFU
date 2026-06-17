import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { io } from 'socket.io-client';

const nodeAUrl = process.env.NODE_A_URL ?? 'http://127.0.0.1:3000';
const nodeBUrl = process.env.NODE_B_URL ?? 'http://127.0.0.1:3002';
const password = process.env.SEED_USER_PASSWORD ?? 'Password@12345';
const capacitySteps = parseSteps(process.env.CAPACITY_STEPS ?? '4,8,12');
const soakCycles = parseInteger(process.env.SOAK_CYCLES, 6);
const soakRooms = parseInteger(process.env.SOAK_ROOMS, 6);
const requestTimeoutMs = parseInteger(process.env.REQUEST_TIMEOUT_MS, 10_000);
const stabilizeMs = parseInteger(process.env.STABILIZE_MS, 350);
const baselineTimeoutMs = parseInteger(process.env.BASELINE_TIMEOUT_MS, 20_000);

const accounts = {
  hostA: { email: 'teacher.one@example.com', password },
  hostB: { email: 'teacher.two@example.com', password },
  studentA: { email: 'student.one@example.com', password },
  studentB: { email: 'student.two@example.com', password },
  studentC: { email: 'student.three@example.com', password }
};

async function main() {
  const startedAt = new Date().toISOString();
  const auth = await authenticateAll();
  const report = {
    startedAt,
    nodeAUrl,
    nodeBUrl,
    soak: [],
    capacity: [],
    remotePublish: null,
    drain: null,
    workerCrash: null,
    browserRerunReminder: 'Use the existing Phase 14 Playwright slice after live soak if browser signoff is needed.',
    finalBaseline: null
  };

  await ensureInitialBaseline(auth.hostA.accessToken, auth.hostB.accessToken);

  for (let cycle = 1; cycle <= soakCycles; cycle += 1) {
    const cycleStartedAt = performance.now();
    const sessions = await createScenarioRooms(soakRooms, auth);
    const peak = await sampleCluster(auth.hostA.accessToken, auth.hostB.accessToken);
    await closeSessions(sessions);
    const baseline = await waitForBaseline(auth.hostA.accessToken, auth.hostB.accessToken);
    report.soak.push({
      cycle,
      rooms: soakRooms,
      durationMs: Math.round(performance.now() - cycleStartedAt),
      peak,
      baseline
    });
  }

  for (const rooms of capacitySteps) {
    const stepStartedAt = performance.now();
    let sessions = [];
    try {
      sessions = await createScenarioRooms(rooms, auth);
      const peak = await sampleCluster(auth.hostA.accessToken, auth.hostB.accessToken);
      report.capacity.push({
        rooms,
        setupMs: Math.round(performance.now() - stepStartedAt),
        success: true,
        peak
      });
    } catch (error) {
      report.capacity.push({
        rooms,
        setupMs: Math.round(performance.now() - stepStartedAt),
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
      await closeSessions(sessions);
      break;
    }
    await closeSessions(sessions);
    await waitForBaseline(auth.hostA.accessToken, auth.hostB.accessToken);
  }

  report.remotePublish = await runRemotePublishSmoke(auth);
  await waitForBaseline(auth.hostA.accessToken, auth.hostB.accessToken);

  report.drain = await runDrainScenario(auth);
  await waitForBaseline(auth.hostA.accessToken, auth.hostB.accessToken);

  report.workerCrash = await runWorkerCrashScenario(auth);
  report.finalBaseline = await waitForBaseline(auth.hostA.accessToken, auth.hostB.accessToken);

  console.log(JSON.stringify(report, null, 2));
}

async function authenticateAll() {
  const entries = await Promise.all(
    Object.entries(accounts).map(async ([key, account]) => [key, await login(key.startsWith('hostB') ? nodeBUrl : nodeAUrl, account)] )
  );
  return Object.fromEntries(entries);
}

async function login(baseUrl, account) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(account)
  });
  if (!response.ok) {
    throw new Error(`Login failed for ${account.email} on ${baseUrl}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function createScenarioRooms(roomCount, auth) {
  const sessions = [];
  for (let index = 0; index < roomCount; index += 1) {
    if (index % 2 === 0) {
      sessions.push(await createRemoteConsumerRoom(index, auth));
    } else {
      sessions.push(await createRemotePublisherRoom(index, auth));
    }
  }
  return sessions;
}

async function createRemoteConsumerRoom(index, auth) {
  const host = await connectParticipant(nodeAUrl, auth.hostA.accessToken);
  const subscriberOne = await connectParticipant(nodeBUrl, auth.studentA.accessToken);
  const subscriberTwo = await connectParticipant(nodeBUrl, auth.studentB.accessToken);
  const room = await emitAck(host.socket, 'room:create', {
    name: `phase14-remote-consumer-${index}-${randomUUID().slice(0, 8)}`,
    maxParticipants: 8,
    waitingRoomEnabled: false,
    joinApprovalRequired: false
  });
  const hostTransport = await emitAck(host.socket, 'transport:create', { roomId: room.id });
  const producer = await emitAck(host.socket, 'producer:create', {
    roomId: room.id,
    kind: 'video',
    transportId: hostTransport.id,
    rtpParameters: syntheticVideoRtpParameters(index + 1)
  });

  const joinedOne = await emitAck(subscriberOne.socket, 'room:join', {
    roomId: room.id,
    displayName: `subscriber-a-${index}`
  });
  const joinedTwo = await emitAck(subscriberTwo.socket, 'room:join', {
    roomId: room.id,
    displayName: `subscriber-b-${index}`
  });
  const transportOne = await emitAck(subscriberOne.socket, 'transport:create', { roomId: room.id });
  const transportTwo = await emitAck(subscriberTwo.socket, 'transport:create', { roomId: room.id });
  const consumerOne = await emitAck(subscriberOne.socket, 'consumer:create', {
    roomId: room.id,
    producerId: producer.id,
    transportId: transportOne.id,
    preferredLayer: 'high'
  });
  const consumerTwo = await emitAck(subscriberTwo.socket, 'consumer:create', {
    roomId: room.id,
    producerId: producer.id,
    transportId: transportTwo.id,
    preferredLayer: 'medium'
  });

  await delay(stabilizeMs);
  return {
    kind: 'remote-consumer',
    roomId: room.id,
    ownerUrl: nodeAUrl,
    host,
    peers: [subscriberOne, subscriberTwo],
    producerIds: [producer.id],
    consumerIds: [consumerOne.id, consumerTwo.id],
    participantIds: [joinedOne.participantId, joinedTwo.participantId]
  };
}

async function createRemotePublisherRoom(index, auth) {
  const host = await connectParticipant(nodeBUrl, auth.hostB.accessToken);
  const remotePublisher = await connectParticipant(nodeAUrl, auth.studentC.accessToken);
  const room = await emitAck(host.socket, 'room:create', {
    name: `phase14-remote-publisher-${index}-${randomUUID().slice(0, 8)}`,
    maxParticipants: 6,
    waitingRoomEnabled: false,
    joinApprovalRequired: false
  });
  const hostTransport = await emitAck(host.socket, 'transport:create', { roomId: room.id });
  await emitAck(remotePublisher.socket, 'room:join', {
    roomId: room.id,
    displayName: `publisher-${index}`
  });
  const publisherTransport = await emitAck(remotePublisher.socket, 'transport:create', { roomId: room.id });
  const remoteProducer = await emitAck(remotePublisher.socket, 'producer:create', {
    roomId: room.id,
    kind: 'video',
    transportId: publisherTransport.id,
    rtpParameters: syntheticVideoRtpParameters(100 + index)
  });
  const hostConsumer = await emitAck(host.socket, 'consumer:create', {
    roomId: room.id,
    producerId: remoteProducer.id,
    transportId: hostTransport.id,
    preferredLayer: 'high'
  });

  await delay(stabilizeMs);
  return {
    kind: 'remote-publisher',
    roomId: room.id,
    ownerUrl: nodeBUrl,
    host,
    peers: [remotePublisher],
    producerIds: [remoteProducer.id],
    consumerIds: [hostConsumer.id]
  };
}

async function runRemotePublishSmoke(auth) {
  const startedAt = performance.now();
  const sessions = [await createRemotePublisherRoom(9_999, auth)];
  const peak = await sampleCluster(auth.hostA.accessToken, auth.hostB.accessToken);
  await closeSessions(sessions);
  const baseline = await waitForBaseline(auth.hostA.accessToken, auth.hostB.accessToken);
  return {
    durationMs: Math.round(performance.now() - startedAt),
    peak,
    baseline
  };
}

async function runDrainScenario(auth) {
  const sessions = await createScenarioRooms(4, auth);
  const before = await sampleCluster(auth.hostA.accessToken, auth.hostB.accessToken);
  const drainResponse = await postJson(`${nodeBUrl}/api/v1/media/node/drain`, auth.hostB.accessToken, { reason: 'phase14_live_soak' });
  const readyDuringDrain = await fetch(`${nodeBUrl}/health/ready`);
  const liveDuringDrain = await fetch(`${nodeBUrl}/health/live`);
  const diagnosticsDuringDrain = await getJson(`${nodeBUrl}/api/v1/media/diagnostics/node`, auth.hostB.accessToken);

  let newRoomRejected = false;
  const drainedSocket = await connectParticipant(nodeBUrl, auth.hostB.accessToken);
  try {
    await emitAck(drainedSocket.socket, 'room:create', {
      name: `phase14-drain-check-${randomUUID().slice(0, 8)}`,
      maxParticipants: 4
    });
  } catch {
    newRoomRejected = true;
  } finally {
    await disconnectParticipant(drainedSocket);
  }

  const undrainResponse = await postJson(`${nodeBUrl}/api/v1/media/node/undrain`, auth.hostB.accessToken, {});
  await closeSessions(sessions);
  const baseline = await waitForBaseline(auth.hostA.accessToken, auth.hostB.accessToken);
  return {
    drainResponse,
    readyStatusDuringDrain: readyDuringDrain.status,
    liveStatusDuringDrain: liveDuringDrain.status,
    diagnosticsDuringDrain: pickNodeSummary(diagnosticsDuringDrain),
    newRoomRejected,
    undrainResponse,
    before,
    baseline
  };
}

async function runWorkerCrashScenario(auth) {
  const sessions = [await createRemotePublisherRoom(20_001, auth), await createRemotePublisherRoom(20_002, auth)];
  const workersBefore = await getJson(`${nodeBUrl}/api/v1/media/workers`, auth.hostB.accessToken);
  const worker = workersBefore.workers?.find((entry) => entry.pid);
  if (!worker?.pid) {
    throw new Error('No live worker pid available for crash validation');
  }
  process.kill(worker.pid, 'SIGKILL');
  const afterCrash = await poll(
    async () => {
      const snapshot = await getJson(`${nodeBUrl}/api/v1/media/workers`, auth.hostB.accessToken);
      const current = snapshot.workers?.find((entry) => entry.workerId === worker.workerId);
      return current && current.restarts > (worker.restarts ?? 0) && current.ready ? snapshot : undefined;
    },
    20_000,
    250
  );
  const recoverySocket = await connectParticipant(nodeBUrl, auth.hostB.accessToken);
  let recoveryRoomId;
  try {
    const room = await emitAck(recoverySocket.socket, 'room:create', {
      name: `phase14-worker-recovery-${randomUUID().slice(0, 8)}`,
      maxParticipants: 4
    });
    recoveryRoomId = room.id;
    await emitAck(recoverySocket.socket, 'room:close', { roomId: room.id });
  } finally {
    await disconnectParticipant(recoverySocket);
  }
  await closeSessions(sessions);
  const baseline = await waitForBaseline(auth.hostA.accessToken, auth.hostB.accessToken);
  return {
    killedWorkerId: worker.workerId,
    killedPid: worker.pid,
    before: {
      readyWorkers: workersBefore.readyWorkers,
      failedRooms: workersBefore.failedRooms,
      worker: pickWorkerSummary(worker)
    },
    afterCrash: {
      readyWorkers: afterCrash.readyWorkers,
      failedRooms: afterCrash.failedRooms,
      worker: pickWorkerSummary(afterCrash.workers.find((entry) => entry.workerId === worker.workerId))
    },
    recoveryRoomId,
    baseline
  };
}

async function ensureInitialBaseline(tokenA, tokenB) {
  await waitForBaseline(tokenA, tokenB);
}

async function waitForBaseline(tokenA, tokenB) {
  return poll(async () => {
    const cluster = await sampleCluster(tokenA, tokenB);
    if (cluster.nodeA.metrics.activeRooms === 0
      && cluster.nodeA.metrics.activeTransports === 0
      && cluster.nodeA.metrics.activeConsumers === 0
      && cluster.nodeA.metrics.activePipeTransports === 0
      && cluster.nodeB.metrics.activeRooms === 0
      && cluster.nodeB.metrics.activeTransports === 0
      && cluster.nodeB.metrics.activeConsumers === 0
      && cluster.nodeB.metrics.activePipeTransports === 0) {
      return cluster;
    }
    return undefined;
  }, baselineTimeoutMs, 250);
}

async function sampleCluster(tokenA, tokenB) {
  const [nodeA, nodeB] = await Promise.all([
    sampleNode(nodeAUrl, tokenA),
    sampleNode(nodeBUrl, tokenB)
  ]);
  return { observedAt: new Date().toISOString(), nodeA, nodeB };
}

async function sampleNode(baseUrl, token) {
  const [diagnostics, workers, metricsText, liveResponse, readyResponse] = await Promise.all([
    getJson(`${baseUrl}/api/v1/media/diagnostics/node`, token),
    getJson(`${baseUrl}/api/v1/media/workers`, token),
    getText(`${baseUrl}/metrics`),
    fetch(`${baseUrl}/health/live`),
    fetch(`${baseUrl}/health/ready`)
  ]);
  return {
    diagnostics: pickNodeSummary(diagnostics),
    workers: {
      mode: workers.mode,
      workerCount: workers.workerCount,
      readyWorkers: workers.readyWorkers,
      drainingWorkers: workers.drainingWorkers,
      overloadedWorkers: workers.overloadedWorkers,
      failedRooms: workers.failedRooms,
      workers: (workers.workers ?? []).map((worker) => pickWorkerSummary(worker))
    },
    metrics: {
      activeRooms: metricSum(metricsText, 'sfu_active_rooms'),
      activeTransports: metricSum(metricsText, 'sfu_active_transports'),
      activeConsumers: metricSum(metricsText, 'sfu_active_consumers'),
      activeProducers: metricSum(metricsText, 'sfu_active_producers'),
      activeParticipants: metricSum(metricsText, 'sfu_active_participants'),
      activePipeTransports: metricSum(metricsText, 'sfu_pipe_transports_active'),
      pipeConsumers: metricSum(metricsText, 'sfu_pipe_consumers'),
      pipeRejectedRequests: metricSum(metricsText, 'sfu_pipe_rejected_requests'),
      workerRestarts: metricSum(metricsText, 'sfu_media_worker_restarts_total'),
      workerCrashes: metricSum(metricsText, 'sfu_media_worker_crashes_total'),
      workerFailedRooms: metricSum(metricsText, 'sfu_media_worker_failed_rooms'),
      roomAdmissionRejections: metricSum(metricsText, 'sfu_room_admission_rejections_total'),
      clusterOwnedRooms: metricSum(metricsText, 'sfu_cluster_owned_rooms')
    },
    readyStatus: readyResponse.status,
    liveStatus: liveResponse.status
  };
}

async function closeSessions(sessions) {
  await Promise.all(sessions.map((session) => closeSession(session)));
  await delay(stabilizeMs);
}

async function closeSession(session) {
  const host = session.host;
  try {
    await emitAck(host.socket, 'room:close', { roomId: session.roomId });
  } catch {
    // Room may already have failed during worker crash or drain validation.
  }
  const participants = [session.host, ...(session.peers ?? [])];
  await Promise.allSettled(participants.map((participant) => disconnectParticipant(participant)));
}

async function connectParticipant(baseUrl, accessToken) {
  const socket = io(`${baseUrl}/sfu`, {
    transports: ['websocket'],
    auth: { token: accessToken },
    reconnection: false
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Socket connect timeout for ${baseUrl}`)), requestTimeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { baseUrl, socket };
}

async function disconnectParticipant(participant) {
  participant.socket.removeAllListeners();
  participant.socket.disconnect();
}

async function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Ack timeout for ${event}`)), requestTimeoutMs);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      if (response?.ok) {
        resolve(response.data);
        return;
      }
      reject(new Error(response?.error?.message ?? `Ack failed for ${event}`));
    });
  });
}

async function getJson(url, accessToken) {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Error(`Request failed ${url}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function postJson(url, accessToken, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Request failed ${url}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed ${url}: ${response.status} ${await response.text()}`);
  }
  return response.text();
}

async function poll(operation, timeoutMs, intervalMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await operation();
    if (result !== undefined) {
      return result;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function syntheticVideoRtpParameters(seed) {
  const primarySsrc = 50_000 + seed;
  return {
    codecs: [
      {
        mimeType: 'video/VP8',
        payloadType: 96,
        clockRate: 90_000,
        rtcpFeedback: ['nack', 'nack pli', 'transport-cc']
      }
    ],
    headerExtensions: [
      { uri: 'urn:ietf:params:rtp-hdrext:sdes:mid', id: 1 },
      { uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time', id: 4 },
      { uri: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01', id: 5 }
    ],
    encodings: [
      {
        ssrc: primarySsrc,
        maxBitrate: 900_000
      }
    ],
    rtcp: {
      cname: `phase14-${seed}`,
      reducedSize: true
    }
  };
}

function metricSum(text, metricName) {
  const pattern = new RegExp(`^${metricName}(?:\\{[^}]*\\})?\\s+([-+]?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)$`, 'gmi');
  let match;
  let sum = 0;
  while ((match = pattern.exec(text)) !== null) {
    sum += Number(match[1] ?? 0);
  }
  return sum;
}

function pickNodeSummary(diagnostics) {
  return {
    localNodeId: diagnostics.localNodeId,
    trafficReady: diagnostics.trafficReady,
    alerts: diagnostics.alerts,
    clusterHealth: diagnostics.cluster?.localNode?.health,
    draining: diagnostics.cluster?.localNode?.draining,
    capacityScore: diagnostics.cluster?.localNode?.capacity?.capacityScore,
    activeRooms: diagnostics.cluster?.localNode?.capacity?.activeRooms,
    activeTransports: diagnostics.cluster?.localNode?.capacity?.activeTransports,
    readyWorkers: diagnostics.workers?.readyWorkers,
    pipeActive: diagnostics.pipe?.summary?.activePipeTransports,
    pipeRejectedRequests: diagnostics.pipe?.summary?.rejectedRequests
  };
}

function pickWorkerSummary(worker) {
  if (!worker) {
    return undefined;
  }
  return {
    workerId: worker.workerId,
    pid: worker.pid,
    ready: worker.ready,
    healthy: worker.healthy,
    draining: worker.draining,
    overloaded: worker.overloaded,
    restarts: worker.restarts,
    crashes: worker.crashes,
    activeRooms: worker.activeRooms,
    activeTransports: worker.activeTransports,
    inflightRequests: worker.inflightRequests,
    queueDepth: worker.queueDepth
  };
}

function parseSteps(value) {
  return value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isInteger(part) && part > 0);
}

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
