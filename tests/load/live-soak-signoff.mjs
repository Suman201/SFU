import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
const enableWorkerCrashValidation = process.env.ENABLE_WORKER_CRASH_VALIDATION === 'true';
const operationsToken = process.env.OPERATIONS_TOKEN;
const reportDir = process.env.REPORT_DIR ?? 'reports/live-soak';
const reportFile = process.env.REPORT_FILE;
const expectDistributed = process.env.EXPECT_DISTRIBUTED === 'true';
const expectPipeEnabled = process.env.EXPECT_PIPE_ENABLED === 'true';
const expectDrainRejectsNewRooms = process.env.EXPECT_DRAIN_REJECTS_NEW_ROOMS !== 'false';
const maxEventLoopMeanMs = parseOptionalNumber(process.env.MAX_EVENT_LOOP_MEAN_MS);
const maxEventLoopMaxMs = parseOptionalNumber(process.env.MAX_EVENT_LOOP_MAX_MS);
const maxProcessRssBytes = parseOptionalNumber(process.env.MAX_PROCESS_RSS_BYTES);
const maxWorkerRssBytes = parseOptionalNumber(process.env.MAX_WORKER_RSS_BYTES);

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
    scenario: {
      capacitySteps,
      soakCycles,
      soakRooms,
      enableWorkerCrashValidation,
      expectDistributed,
      expectPipeEnabled,
      expectDrainRejectsNewRooms,
      thresholds: {
        maxEventLoopMeanMs,
        maxEventLoopMaxMs,
        maxProcessRssBytes,
        maxWorkerRssBytes
      },
      operationsTokenConfigured: Boolean(operationsToken)
    },
    soak: [],
    capacity: [],
    remotePublish: null,
    drain: null,
    workerCrash: null,
    browserRerunReminder: 'Use the current Playwright browser slice after live soak if browser signoff is needed.',
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
  report.completedAt = new Date().toISOString();
  report.result = evaluateReport(report);
  report.reportPath = resolveReportPath(report.startedAt);
  await writeReport(report, report.reportPath);

  console.log(JSON.stringify(report, null, 2));
  if (!report.result.passed) {
    process.exitCode = 1;
  }
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
    name: `release-gate-remote-consumer-${index}-${randomUUID().slice(0, 8)}`,
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
    name: `release-gate-remote-publisher-${index}-${randomUUID().slice(0, 8)}`,
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
  const drainResponse = await postJson(`${nodeBUrl}/api/v1/media/node/drain`, auth.hostB.accessToken, { reason: 'release_gate_live_soak' });
  const readyDuringDrain = await fetch(`${nodeBUrl}/health/ready`);
  const liveDuringDrain = await fetch(`${nodeBUrl}/health/live`);
  const diagnosticsDuringDrain = await getJson(`${nodeBUrl}/api/v1/media/diagnostics/node`, auth.hostB.accessToken);

  let newRoomRejected = false;
  const drainedSocket = await connectParticipant(nodeBUrl, auth.hostB.accessToken);
  try {
    await emitAck(drainedSocket.socket, 'room:create', {
      name: `release-gate-drain-check-${randomUUID().slice(0, 8)}`,
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
  if (!enableWorkerCrashValidation) {
    return {
      skipped: true,
      reason: 'Set ENABLE_WORKER_CRASH_VALIDATION=true to opt into destructive local worker crash validation.'
    };
  }
  if (!isLocalCrashTarget(nodeBUrl)) {
    return {
      skipped: true,
      reason: `Worker crash validation only runs against local node targets; received ${nodeBUrl}.`
    };
  }
  const sessions = [await createRemotePublisherRoom(20_001, auth), await createRemotePublisherRoom(20_002, auth)];
  const workersBefore = await getJson(`${nodeBUrl}/api/v1/media/workers`, auth.hostB.accessToken);
  const worker = workersBefore.workers?.find((entry) => entry.pid);
  if (!worker?.pid) {
    throw new Error('No live worker pid available for crash validation');
  }
  const baselineRestartCount = worker.restarts ?? 0;
  const baselinePid = worker.pid;
  process.kill(worker.pid, 'SIGKILL');
  const afterCrash = await poll(
    async () => {
      const snapshot = await getJson(`${nodeBUrl}/api/v1/media/workers`, auth.hostB.accessToken);
      const current = snapshot.workers?.find((entry) => entry.workerId === worker.workerId);
      return current
        && current.ready
        && ((current.restarts ?? 0) > baselineRestartCount || (current.pid ?? 0) !== baselinePid)
        ? snapshot
        : undefined;
    },
    20_000,
    250
  );
  const recoverySocket = await connectParticipant(nodeBUrl, auth.hostB.accessToken);
  let recoveryRoomId;
  try {
    const room = await emitAck(recoverySocket.socket, 'room:create', {
      name: `release-gate-worker-recovery-${randomUUID().slice(0, 8)}`,
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
  let lastCluster;
  const baseline = await poll(async () => {
    const cluster = await sampleCluster(tokenA, tokenB);
    lastCluster = cluster;
    if (cluster.nodeA.metrics.activeRooms === 0
      && cluster.nodeA.metrics.activeTransports === 0
      && cluster.nodeA.metrics.activeConsumers === 0
      && cluster.nodeA.metrics.activeProducers === 0
      && cluster.nodeA.metrics.activeParticipants === 0
      && cluster.nodeA.metrics.activePipeTransports === 0
      && cluster.nodeB.metrics.activeRooms === 0
      && cluster.nodeB.metrics.activeTransports === 0
      && cluster.nodeB.metrics.activeConsumers === 0
      && cluster.nodeB.metrics.activeProducers === 0
      && cluster.nodeB.metrics.activeParticipants === 0
      && cluster.nodeB.metrics.activePipeTransports === 0) {
      return cluster;
    }
    return undefined;
  }, baselineTimeoutMs, 250).catch((error) => {
    if (lastCluster) {
      const timeoutMessage = `${error instanceof Error ? error.message : String(error)}; last baseline sample=${JSON.stringify(lastCluster)}`;
      throw new Error(timeoutMessage);
    }
    throw error;
  });
  return baseline;
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
      workerRssBytes: metricSum(metricsText, 'sfu_media_worker_rss_bytes'),
      workerCpuUserMicros: metricSum(metricsText, 'sfu_media_worker_cpu_user_micros'),
      workerCpuSystemMicros: metricSum(metricsText, 'sfu_media_worker_cpu_system_micros'),
      workerIpcQueueDepth: metricSum(metricsText, 'sfu_media_worker_ipc_queue_depth'),
      roomAdmissionRejections: metricSum(metricsText, 'sfu_room_admission_rejections_total'),
      clusterOwnedRooms: metricSum(metricsText, 'sfu_cluster_owned_rooms'),
      clusterRegisteredNodes: metricValue(metricsText, 'sfu_cluster_registered_nodes'),
      clusterHealthyNodes: metricValue(metricsText, 'sfu_cluster_healthy_nodes'),
      processResidentMemoryBytes: metricValue(metricsText, 'process_resident_memory_bytes'),
      processCpuUserSeconds: metricValue(metricsText, 'process_cpu_user_seconds_total'),
      processCpuSystemSeconds: metricValue(metricsText, 'process_cpu_system_seconds_total'),
      eventLoopLagMeanMs: secondsToMs(metricValue(metricsText, 'nodejs_eventloop_lag_mean_seconds')),
      eventLoopLagMaxMs: secondsToMs(metricValue(metricsText, 'nodejs_eventloop_lag_max_seconds')),
      metricsRefreshStatus: {
        cluster: metricLabelValue(metricsText, 'sfu_metrics_refresh_status', { component: 'cluster' }),
        pipe: metricLabelValue(metricsText, 'sfu_metrics_refresh_status', { component: 'pipe' }),
        mediaWorkers: metricLabelValue(metricsText, 'sfu_metrics_refresh_status', { component: 'media_workers' })
      }
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
    headers: requestHeaders(accessToken)
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
      ...requestHeaders(accessToken),
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
  const response = await fetch(url, {
    headers: requestHeaders()
  });
  if (!response.ok) {
    throw new Error(`Request failed ${url}: ${response.status} ${await response.text()}`);
  }
  return response.text();
}

function requestHeaders(accessToken) {
  const headers = {};
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }
  if (operationsToken) {
    headers['x-operations-token'] = operationsToken;
  }
  return headers;
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
      cname: `release-gate-${seed}`,
      reducedSize: true
    }
  };
}

function isLocalCrashTarget(url) {
  try {
    const { hostname } = new URL(url);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
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

function metricValue(text, metricName) {
  const pattern = new RegExp(`^${metricName}(?:\\{[^}]*\\})?\\s+([-+]?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)$`, 'gmi');
  const match = pattern.exec(text);
  return match ? Number(match[1] ?? 0) : undefined;
}

function metricLabelValue(text, metricName, expectedLabels) {
  const pattern = new RegExp(`^${metricName}\\{([^}]*)\\}\\s+([-+]?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)$`, 'gmi');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const labels = parseLabels(match[1] ?? '');
    const allMatch = Object.entries(expectedLabels).every(([key, value]) => labels[key] === value);
    if (allMatch) {
      return Number(match[2] ?? 0);
    }
  }
  return undefined;
}

function parseLabels(raw) {
  const labels = {};
  for (const entry of raw.split(',')) {
    const [key, value] = entry.split('=');
    if (!key || value === undefined) {
      continue;
    }
    labels[key.trim()] = value.trim().replace(/^"|"$/g, '');
  }
  return labels;
}

function secondsToMs(value) {
  return value === undefined ? undefined : Math.round(value * 1000 * 1000) / 1000;
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
    averageIpcLatencyMs: diagnostics.cluster?.localNode?.capacity?.averageIpcLatencyMs,
    memoryRssBytes: diagnostics.cluster?.localNode?.capacity?.memoryRssBytes,
    cpuUserMicros: diagnostics.cluster?.localNode?.capacity?.cpuUserMicros,
    readyWorkers: diagnostics.workers?.readyWorkers,
    turnReady: diagnostics.turn?.secretConfigured && (diagnostics.turn?.supportedUriCount ?? 0) > 0,
    turnSupportedUriCount: diagnostics.turn?.supportedUriCount,
    turnLocalhostUriCount: diagnostics.turn?.localhostUriCount,
    turnUdpOnly: diagnostics.turn?.udpOnly,
    pipeEnabled: diagnostics.pipe?.health?.enabled,
    pipeSupported: diagnostics.pipe?.health?.supported,
    pipeRuntimeReason: diagnostics.pipe?.health?.reason,
    pipeActive: diagnostics.pipe?.summary?.activePipeTransports,
    pipeRejectedRequests: diagnostics.pipe?.summary?.rejectedRequests,
    pipeConsumers: diagnostics.pipe?.summary?.pipeConsumers,
    pipeProducers: diagnostics.pipe?.summary?.pipeProducers
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
    queueDepth: worker.queueDepth,
    averageIpcLatencyMs: worker.averageIpcLatencyMs,
    memoryRssBytes: worker.memory?.rss,
    heapUsedBytes: worker.memory?.heapUsed,
    cpuUserMicros: worker.cpu?.user,
    cpuSystemMicros: worker.cpu?.system
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

function parseOptionalNumber(value) {
  if (value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function evaluateReport(report) {
  const failedChecks = [];
  const warningChecks = [];
  const allSamples = [
    ...report.soak.flatMap((entry) => [entry.peak, entry.baseline]),
    ...report.capacity.flatMap((entry) => [entry.peak].filter(Boolean)),
    report.remotePublish?.peak,
    report.remotePublish?.baseline,
    report.drain?.before,
    report.drain?.baseline,
    report.workerCrash?.baseline,
    report.finalBaseline
  ].filter(Boolean);

  if (!report.finalBaseline) {
    failedChecks.push({ check: 'final-baseline', reason: 'No final baseline sample was captured.' });
  } else {
    for (const [nodeKey, node] of Object.entries(nodesOf(report.finalBaseline))) {
      assertZero(node.metrics.activeRooms, `${nodeKey}.activeRooms`, failedChecks);
      assertZero(node.metrics.activeTransports, `${nodeKey}.activeTransports`, failedChecks);
      assertZero(node.metrics.activeConsumers, `${nodeKey}.activeConsumers`, failedChecks);
      assertZero(node.metrics.activeProducers, `${nodeKey}.activeProducers`, failedChecks);
      assertZero(node.metrics.activeParticipants, `${nodeKey}.activeParticipants`, failedChecks);
      assertZero(node.metrics.activePipeTransports, `${nodeKey}.activePipeTransports`, failedChecks);
      assertZero(node.metrics.workerFailedRooms, `${nodeKey}.workerFailedRooms`, failedChecks);
    }
  }

  if (!report.capacity.every((entry) => entry.success)) {
    failedChecks.push({ check: 'capacity', reason: 'At least one capacity step failed.', failedSteps: report.capacity.filter((entry) => !entry.success) });
  }

  if (expectDrainRejectsNewRooms && report.drain?.newRoomRejected !== true) {
    failedChecks.push({ check: 'drain-new-room-rejection', reason: 'Node drain did not reject a new room create request.' });
  }

  for (const [sampleIndex, sample] of allSamples.entries()) {
    for (const [nodeKey, node] of Object.entries(nodesOf(sample))) {
      if (node.readyStatus !== 200) {
        failedChecks.push({ check: 'ready-status', sampleIndex, node: nodeKey, expected: 200, actual: node.readyStatus });
      }
      if (node.liveStatus !== 200) {
        failedChecks.push({ check: 'live-status', sampleIndex, node: nodeKey, expected: 200, actual: node.liveStatus });
      }
      if (node.workers.readyWorkers !== node.workers.workerCount) {
        failedChecks.push({
          check: 'worker-readiness',
          sampleIndex,
          node: nodeKey,
          expected: node.workers.workerCount,
          actual: node.workers.readyWorkers
        });
      }
      const refreshStatus = node.metrics.metricsRefreshStatus ?? {};
      for (const [component, status] of Object.entries(refreshStatus)) {
        if (status !== undefined && status !== 1) {
          failedChecks.push({ check: 'metrics-refresh-status', sampleIndex, node: nodeKey, component, expected: 1, actual: status });
        }
      }
      if (maxEventLoopMeanMs !== undefined && node.metrics.eventLoopLagMeanMs !== undefined && node.metrics.eventLoopLagMeanMs > maxEventLoopMeanMs) {
        failedChecks.push({
          check: 'event-loop-mean',
          sampleIndex,
          node: nodeKey,
          max: maxEventLoopMeanMs,
          actual: node.metrics.eventLoopLagMeanMs
        });
      }
      if (maxEventLoopMaxMs !== undefined && node.metrics.eventLoopLagMaxMs !== undefined && node.metrics.eventLoopLagMaxMs > maxEventLoopMaxMs) {
        failedChecks.push({
          check: 'event-loop-max',
          sampleIndex,
          node: nodeKey,
          max: maxEventLoopMaxMs,
          actual: node.metrics.eventLoopLagMaxMs
        });
      }
      if (maxProcessRssBytes !== undefined && node.metrics.processResidentMemoryBytes !== undefined && node.metrics.processResidentMemoryBytes > maxProcessRssBytes) {
        failedChecks.push({
          check: 'process-rss',
          sampleIndex,
          node: nodeKey,
          max: maxProcessRssBytes,
          actual: node.metrics.processResidentMemoryBytes
        });
      }
      if (maxWorkerRssBytes !== undefined && node.metrics.workerRssBytes !== undefined && node.metrics.workerRssBytes > maxWorkerRssBytes) {
        failedChecks.push({
          check: 'worker-rss',
          sampleIndex,
          node: nodeKey,
          max: maxWorkerRssBytes,
          actual: node.metrics.workerRssBytes
        });
      }
    }
  }

  if (expectDistributed) {
    const distributedSamples = allSamples.filter((sample) => {
      const nodes = Object.values(nodesOf(sample));
      return nodes.some((node) => (node.metrics.clusterRegisteredNodes ?? 0) >= 2)
        && nodes.some((node) => (node.metrics.clusterHealthyNodes ?? 0) >= 2);
    });
    if (distributedSamples.length === 0) {
      failedChecks.push({ check: 'distributed-cluster', reason: 'No sample observed at least two registered and healthy nodes.' });
    }
  }

  if (expectPipeEnabled) {
    const pipeHealthSamples = allSamples.flatMap((sample) => Object.values(nodesOf(sample))).filter((node) => node.diagnostics.pipeEnabled);
    if (pipeHealthSamples.length === 0) {
      failedChecks.push({ check: 'pipe-enabled', reason: 'No node diagnostics sample reported pipe enabled.' });
    }
    const unsupported = pipeHealthSamples.filter((node) => node.diagnostics.pipeSupported === false);
    if (unsupported.length > 0) {
      failedChecks.push({
        check: 'pipe-supported',
        reason: 'At least one pipe-enabled node reported unsupported runtime.',
        nodes: unsupported.map((node) => ({ nodeId: node.diagnostics.localNodeId, reason: node.diagnostics.pipeRuntimeReason }))
      });
    }
    const hadPipeTraffic = allSamples.some((sample) => Object.values(nodesOf(sample)).some((node) => {
      return (node.metrics.activePipeTransports ?? 0) > 0
        || (node.metrics.pipeConsumers ?? 0) > 0
        || (node.diagnostics.pipeActive ?? 0) > 0
        || (node.diagnostics.pipeConsumers ?? 0) > 0;
    }));
    if (!hadPipeTraffic) {
      warningChecks.push({ check: 'pipe-traffic', reason: 'Pipe is enabled, but no sampled peak showed active pipe transports or consumers.' });
    }
  }

  return {
    passed: failedChecks.length === 0,
    failedChecks,
    warningChecks
  };
}

function nodesOf(sample) {
  return {
    nodeA: sample.nodeA,
    nodeB: sample.nodeB
  };
}

function assertZero(value, name, failedChecks) {
  if ((value ?? 0) !== 0) {
    failedChecks.push({ check: 'baseline-zero', metric: name, expected: 0, actual: value });
  }
}

function resolveReportPath(startedAt) {
  if (reportFile === 'stdout') {
    return undefined;
  }
  return reportFile ?? join(reportDir, `live-soak-${safeTimestamp(startedAt)}.json`);
}

async function writeReport(report, path) {
  if (!path) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function safeTimestamp(value) {
  return value.replace(/[:.]/g, '-');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
