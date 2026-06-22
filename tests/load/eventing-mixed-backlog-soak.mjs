import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { MongoClient } from 'mongodb';
import Redis from 'ioredis';
import { io } from 'socket.io-client';

const nodeAUrl = process.env.NODE_A_URL ?? 'http://127.0.0.1:3000';
const nodeBUrl = process.env.NODE_B_URL ?? 'http://127.0.0.1:3002';
const password = process.env.SEED_USER_PASSWORD ?? 'Password@12345';
const operationsToken = process.env.OPERATIONS_TOKEN;
const roomCount = parseInteger(process.env.EVENTING_SOAK_ROOMS, 8);
const requestTimeoutMs = parseInteger(process.env.REQUEST_TIMEOUT_MS, 10_000);
const stabilizeMs = parseInteger(process.env.STABILIZE_MS, 250);
const diagnosticsPollMs = parseInteger(process.env.EVENTING_DIAGNOSTICS_POLL_MS, 750);
const drainTimeoutMs = parseInteger(process.env.EVENTING_DRAIN_TIMEOUT_MS, 90_000);
const webhookListenHost = process.env.WEBHOOK_SERVER_HOST ?? '127.0.0.1';
const webhookServerPort = parseInteger(process.env.WEBHOOK_SERVER_PORT, 4319);
const webhookEndpointBaseUrl = process.env.WEBHOOK_ENDPOINT_BASE_URL ?? `http://${webhookListenHost}:${webhookServerPort}`;
const slowWebhookDelayMs = parseInteger(process.env.WEBHOOK_SLOW_DELAY_MS, 1_200);
const dominantNodeShareLimit = parseFloat(process.env.EVENTING_MAX_DOMINANT_NODE_SHARE ?? '0.95');
const runId = process.env.EVENTING_SOAK_RUN_ID ?? randomUUID().slice(0, 10);

const roomEventTypes = ['room.created', 'room.joined', 'room.left', 'room.closed', 'producer.created', 'consumer.created'];
const mongoUriCandidates = dedupe([
  process.env.EVENTING_MONGODB_URI,
  process.env.MONGODB_URI,
  'mongodb://127.0.0.1:27018/native_sfu?directConnection=true',
  'mongodb://127.0.0.1:27017/native_sfu?directConnection=true'
]);
const redisUrlCandidates = dedupe([
  process.env.EVENTING_REDIS_URL,
  process.env.REDIS_URL,
  'redis://127.0.0.1:6379'
]);

const accounts = {
  hostA: { email: 'teacher.one@example.com', password },
  hostB: { email: 'teacher.two@example.com', password },
  studentA: { email: 'student.one@example.com', password },
  studentB: { email: 'student.two@example.com', password },
  studentC: { email: 'student.three@example.com', password }
};

async function main() {
  const startedAtIso = new Date().toISOString();
  const mongo = await connectMongo();
  const redis = await connectRedis();
  const webhookServer = await startWebhookServer();
  const auth = await authenticateAll();
  const sessions = [];
  const createdEndpoints = [];

  try {
    const bootstrappedRooms = await bootstrapRooms(auth);
    sessions.push(...bootstrappedRooms);

    const roomIds = sessions.map((session) => session.roomId);
    const endpoints = await createMixedEndpoints(roomIds);
    createdEndpoints.push(...endpoints.all);

    const beforeMetrics = await sampleNodeMetrics();
    const eventWindowStartedAt = new Date();

    await exerciseRooms(sessions, auth);
    await closePeerLeaves(sessions);
    await closeSessions(sessions);

    const drainSnapshots = await collectUntilDrained();
    const afterMetrics = await sampleNodeMetrics();

    const mongoEvidence = await collectMongoEvidence(mongo, {
      startedAt: eventWindowStartedAt,
      roomIds,
      endpointIds: createdEndpoints.map((endpoint) => endpoint.id)
    });
    const redisEvidence = await collectRedisEvidence(redis, endpoints.redis);

    const fairness = summarizeFairness(beforeMetrics, afterMetrics);
    const finalSnapshot = drainSnapshots.at(-1);
    const peak = summarizePeakSnapshots(drainSnapshots);
    const webhookStats = webhookServer.snapshot();

    assertRun({
      finalSnapshot,
      fairness,
      webhookStats,
      mongoEvidence,
      redisEvidence
    });

    const report = {
      runId,
      startedAt: startedAtIso,
      completedAt: new Date().toISOString(),
      nodeAUrl,
      nodeBUrl,
      distributed: normalizeUrl(nodeAUrl) !== normalizeUrl(nodeBUrl),
      webhookEndpointBaseUrl,
      mongoUri: mongo.connectedUri,
      redisUrl: redis.connectedUrl,
      roomCount,
      endpoints: {
        webhooks: endpoints.webhooks.map(summarizeEndpoint),
        redisStreams: endpoints.redis.map(summarizeEndpoint)
      },
      beforeMetrics,
      afterMetrics,
      fairness,
      peak,
      finalDiagnostics: finalSnapshot,
      webhookReceipts: webhookStats,
      mongoEvidence,
      redisEvidence
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await Promise.allSettled([
      disableEndpoints(createdEndpoints),
      closeSessions(sessions),
      webhookServer.close(),
      mongo.client.close(),
      redis.client.quit()
    ]);
  }
}

async function authenticateAll() {
  const entries = await Promise.all(
    Object.entries(accounts).map(async ([key, account]) => [key, await login(key === 'hostB' ? nodeBUrl : nodeAUrl, account)])
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

async function bootstrapRooms(auth) {
  const sessions = [];
  for (let index = 0; index < roomCount; index += 1) {
    if (index % 2 === 0) {
      sessions.push(await bootstrapRemoteConsumerRoom(index, auth));
    } else {
      sessions.push(await bootstrapRemotePublisherRoom(index, auth));
    }
  }
  return sessions;
}

async function bootstrapRemoteConsumerRoom(index, auth) {
  const host = await connectParticipant(nodeAUrl, auth.hostA.accessToken);
  const room = await emitAck(host.socket, 'room:create', {
    name: `eventing-remote-consumer-${runId}-${index}`,
    maxParticipants: 8,
    waitingRoomEnabled: false,
    joinApprovalRequired: false
  });
  return {
    kind: 'remote-consumer',
    index,
    roomId: room.id,
    ownerUrl: nodeAUrl,
    host,
    peers: [],
    producerIds: [],
    consumerIds: []
  };
}

async function bootstrapRemotePublisherRoom(index, auth) {
  const host = await connectParticipant(nodeBUrl, auth.hostB.accessToken);
  const room = await emitAck(host.socket, 'room:create', {
    name: `eventing-remote-publisher-${runId}-${index}`,
    maxParticipants: 6,
    waitingRoomEnabled: false,
    joinApprovalRequired: false
  });
  return {
    kind: 'remote-publisher',
    index,
    roomId: room.id,
    ownerUrl: nodeBUrl,
    host,
    peers: [],
    producerIds: [],
    consumerIds: []
  };
}

async function exerciseRooms(sessions, auth) {
  for (const session of sessions) {
    if (session.kind === 'remote-consumer') {
      await exerciseRemoteConsumerRoom(session, auth);
      continue;
    }
    await exerciseRemotePublisherRoom(session, auth);
  }
}

async function exerciseRemoteConsumerRoom(session, auth) {
  const subscriberOne = await connectParticipant(nodeBUrl, auth.studentA.accessToken);
  const subscriberTwo = await connectParticipant(nodeBUrl, auth.studentB.accessToken);
  session.peers.push(subscriberOne, subscriberTwo);

  const hostTransport = await emitAck(session.host.socket, 'transport:create', { roomId: session.roomId });
  const producer = await emitAck(session.host.socket, 'producer:create', {
    roomId: session.roomId,
    kind: 'video',
    transportId: hostTransport.id,
    rtpParameters: syntheticVideoRtpParameters(session.index + 1)
  });

  await emitAck(subscriberOne.socket, 'room:join', {
    roomId: session.roomId,
    displayName: `eventing-subscriber-a-${session.index}`
  });
  await emitAck(subscriberTwo.socket, 'room:join', {
    roomId: session.roomId,
    displayName: `eventing-subscriber-b-${session.index}`
  });
  const transportOne = await emitAck(subscriberOne.socket, 'transport:create', { roomId: session.roomId });
  const transportTwo = await emitAck(subscriberTwo.socket, 'transport:create', { roomId: session.roomId });
  const consumerOne = await emitAck(subscriberOne.socket, 'consumer:create', {
    roomId: session.roomId,
    producerId: producer.id,
    transportId: transportOne.id,
    preferredLayer: 'high'
  });
  const consumerTwo = await emitAck(subscriberTwo.socket, 'consumer:create', {
    roomId: session.roomId,
    producerId: producer.id,
    transportId: transportTwo.id,
    preferredLayer: 'medium'
  });
  session.producerIds.push(producer.id);
  session.consumerIds.push(consumerOne.id, consumerTwo.id);
  await delay(stabilizeMs);
}

async function exerciseRemotePublisherRoom(session, auth) {
  const remotePublisher = await connectParticipant(nodeAUrl, auth.studentC.accessToken);
  session.peers.push(remotePublisher);

  await emitAck(remotePublisher.socket, 'room:join', {
    roomId: session.roomId,
    displayName: `eventing-publisher-${session.index}`
  });
  const hostTransport = await emitAck(session.host.socket, 'transport:create', { roomId: session.roomId });
  const publisherTransport = await emitAck(remotePublisher.socket, 'transport:create', { roomId: session.roomId });
  const producer = await emitAck(remotePublisher.socket, 'producer:create', {
    roomId: session.roomId,
    kind: 'video',
    transportId: publisherTransport.id,
    rtpParameters: syntheticVideoRtpParameters(100 + session.index)
  });
  const consumer = await emitAck(session.host.socket, 'consumer:create', {
    roomId: session.roomId,
    producerId: producer.id,
    transportId: hostTransport.id,
    preferredLayer: 'high'
  });
  session.producerIds.push(producer.id);
  session.consumerIds.push(consumer.id);
  await delay(stabilizeMs);
}

async function closePeerLeaves(sessions) {
  for (const session of sessions) {
    const peer = session.peers[0];
    if (!peer) {
      continue;
    }
    try {
      await emitAck(peer.socket, 'room:leave', { roomId: session.roomId });
    } catch {
      // A leave event may already have been implied by an earlier disconnect.
    }
    await disconnectParticipant(peer);
    session.peers = session.peers.filter((entry) => entry !== peer);
  }
}

async function closeSessions(sessions) {
  await Promise.allSettled(sessions.map((session) => closeSession(session)));
}

async function closeSession(session) {
  if (session.closed) {
    return;
  }
  session.closed = true;
  try {
    await emitAck(session.host.socket, 'room:close', { roomId: session.roomId });
  } catch {
    // Room may already have closed during cleanup.
  }
  const participants = [session.host, ...(session.peers ?? [])];
  await Promise.allSettled(participants.map((participant) => disconnectParticipant(participant)));
  session.peers = [];
}

async function createMixedEndpoints(roomIds) {
  const shared = {
    roomFilterIds: roomIds,
    subscribedEventTypes: roomEventTypes
  };
  const webhookFast = await postJson(`${nodeAUrl}/api/v1/events/webhooks`, null, {
    name: `eventing-fast-${runId}`,
    url: `${webhookEndpointBaseUrl}/fast`,
    signingSecret: `eventing-fast-secret-${runId}-1234567890`,
    timeoutMs: 2_000,
    maxAttempts: 3,
    initialBackoffMs: 400,
    ...shared
  });
  const webhookSlow = await postJson(`${nodeAUrl}/api/v1/events/webhooks`, null, {
    name: `eventing-slow-${runId}`,
    url: `${webhookEndpointBaseUrl}/slow`,
    signingSecret: `eventing-slow-secret-${runId}-1234567890`,
    timeoutMs: Math.max(2_500, slowWebhookDelayMs + 1_000),
    maxAttempts: 3,
    initialBackoffMs: 500,
    ...shared
  });
  const webhookFail = await postJson(`${nodeAUrl}/api/v1/events/webhooks`, null, {
    name: `eventing-fail-${runId}`,
    url: `${webhookEndpointBaseUrl}/fail`,
    signingSecret: `eventing-fail-secret-${runId}-1234567890`,
    timeoutMs: 1_500,
    maxAttempts: 2,
    initialBackoffMs: 350,
    ...shared
  });
  const redisPrimary = await postJson(`${nodeAUrl}/api/v1/events/redis-streams`, null, {
    name: `eventing-stream-a-${runId}`,
    streamKey: `ops:eventing:${runId}:a`,
    maxLen: 2_000,
    timeoutMs: 1_000,
    maxAttempts: 2,
    initialBackoffMs: 400,
    ...shared
  });
  const redisSecondary = await postJson(`${nodeAUrl}/api/v1/events/redis-streams`, null, {
    name: `eventing-stream-b-${runId}`,
    streamKey: `ops:eventing:${runId}:b`,
    maxLen: 2_000,
    timeoutMs: 1_000,
    maxAttempts: 2,
    initialBackoffMs: 400,
    ...shared
  });
  return {
    all: [webhookFast.endpoint, webhookSlow.endpoint, webhookFail.endpoint, redisPrimary, redisSecondary],
    webhooks: [webhookFast.endpoint, webhookSlow.endpoint, webhookFail.endpoint],
    redis: [redisPrimary, redisSecondary]
  };
}

async function disableEndpoints(endpoints) {
  await Promise.allSettled(
    endpoints.map(async (endpoint) => {
      const path = endpoint.adapterKind === 'redis-stream' ? 'redis-streams' : 'webhooks';
      await patchJson(`${nodeAUrl}/api/v1/events/${path}/${endpoint.id}`, null, { enabled: false });
    })
  );
}

async function collectUntilDrained() {
  const snapshots = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < drainTimeoutMs) {
    const snapshot = await sampleEventingState();
    snapshots.push(snapshot);
    if (isDrained(snapshot)) {
      return snapshots;
    }
    await delay(diagnosticsPollMs);
  }
  throw new Error(`Timed out waiting for mixed-adapter backlog drain after ${drainTimeoutMs}ms`);
}

function isDrained(snapshot) {
  const summaryA = snapshot.nodeA.summary;
  const summaryB = snapshot.nodeB.summary;
  const shared = summaryA.deliveryCounts.queued === 0
    && summaryA.deliveryCounts.retrying === 0
    && summaryA.deliveryCounts.dispatching === 0
    && summaryA.adapterCounts.webhook === 0
    && summaryA.adapterCounts['redis-stream'] === 0
    && summaryA.leaseCounts.expired === 0;
  return shared
    && summaryA.dispatch.activeDispatches === 0
    && summaryB.dispatch.activeDispatches === 0
    && summaryA.activeDispatchesByAdapter.webhook === 0
    && summaryA.activeDispatchesByAdapter['redis-stream'] === 0
    && summaryB.activeDispatchesByAdapter.webhook === 0
    && summaryB.activeDispatchesByAdapter['redis-stream'] === 0;
}

async function sampleEventingState() {
  const [nodeASummary, nodeBSummary] = await Promise.all([
    getJson(`${nodeAUrl}/api/v1/events/diagnostics/summary`),
    getJson(`${nodeBUrl}/api/v1/events/diagnostics/summary`)
  ]);
  return {
    observedAt: new Date().toISOString(),
    nodeA: { summary: nodeASummary },
    nodeB: { summary: nodeBSummary }
  };
}

async function sampleNodeMetrics() {
  const [nodeA, nodeB] = await Promise.all([
    sampleMetricsForNode(nodeAUrl),
    sampleMetricsForNode(nodeBUrl)
  ]);
  return { nodeA, nodeB };
}

async function sampleMetricsForNode(baseUrl) {
  const text = await getText(`${baseUrl}/metrics`);
  return {
    attemptsByAdapter: {
      webhook: metricSumByLabel(text, 'sfu_event_delivery_attempts_total', { adapter: 'webhook' }),
      'redis-stream': metricSumByLabel(text, 'sfu_event_delivery_attempts_total', { adapter: 'redis-stream' })
    },
    executionsByAdapter: {
      webhook: metricSumByLabel(text, 'sfu_event_delivery_adapter_executions_total', { adapter: 'webhook' }),
      'redis-stream': metricSumByLabel(text, 'sfu_event_delivery_adapter_executions_total', { adapter: 'redis-stream' })
    },
    retriesByAdapter: {
      webhook: metricSumByLabel(text, 'sfu_event_retries_scheduled_total', { adapter: 'webhook' }),
      'redis-stream': metricSumByLabel(text, 'sfu_event_retries_scheduled_total', { adapter: 'redis-stream' })
    },
    exhaustedByAdapter: {
      webhook: metricSumByLabel(text, 'sfu_event_deliveries_exhausted_total', { adapter: 'webhook' }),
      'redis-stream': metricSumByLabel(text, 'sfu_event_deliveries_exhausted_total', { adapter: 'redis-stream' })
    }
  };
}

function summarizeFairness(beforeMetrics, afterMetrics) {
  const distributed = normalizeUrl(nodeAUrl) !== normalizeUrl(nodeBUrl);
  const delta = {
    nodeA: subtractMetricSnapshot(afterMetrics.nodeA, beforeMetrics.nodeA),
    nodeB: subtractMetricSnapshot(afterMetrics.nodeB, beforeMetrics.nodeB)
  };
  const totals = {
    nodeA: sumObject(delta.nodeA.executionsByAdapter),
    nodeB: sumObject(delta.nodeB.executionsByAdapter)
  };
  const combined = distributed ? totals.nodeA + totals.nodeB : totals.nodeA;
  const dominantShare = combined > 0 ? Math.max(totals.nodeA, distributed ? totals.nodeB : 0) / combined : 0;
  return {
    delta,
    totals,
    dominantShare,
    dominantShareLimit,
    bothNodesParticipated: distributed && totals.nodeA > 0 && totals.nodeB > 0
  };
}

async function collectMongoEvidence(mongo, { startedAt, roomIds, endpointIds }) {
  const db = mongo.client.db();
  const platformEvents = db.collection('platform_events');
  const deliveries = db.collection('webhook_deliveries');

  const [eventRows, deliveryRows, exhaustedSamples] = await Promise.all([
    platformEvents.aggregate([
      {
        $match: {
          roomId: { $in: roomIds },
          occurredAt: { $gte: startedAt }
        }
      },
      {
        $group: {
          _id: { type: '$type', sourceNodeId: '$sourceNodeId' },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.type': 1, '_id.sourceNodeId': 1 } }
    ]).toArray(),
    deliveries.aggregate([
      {
        $match: {
          endpointId: { $in: endpointIds },
          roomId: { $in: roomIds },
          createdAt: { $gte: startedAt }
        }
      },
      {
        $group: {
          _id: { adapterKind: '$adapterKind', endpointId: '$endpointId', status: '$status' },
          count: { $sum: 1 },
          maxAttemptCount: { $max: '$attemptCount' }
        }
      },
      { $sort: { '_id.adapterKind': 1, '_id.endpointId': 1, '_id.status': 1 } }
    ]).toArray(),
    deliveries.find({
      endpointId: { $in: endpointIds },
      roomId: { $in: roomIds },
      createdAt: { $gte: startedAt },
      status: 'exhausted'
    }).limit(5).toArray()
  ]);

  return {
    eventCounts: eventRows.map((row) => ({
      type: row._id.type,
      sourceNodeId: row._id.sourceNodeId,
      count: row.count
    })),
    deliveryCounts: deliveryRows.map((row) => ({
      adapterKind: row._id.adapterKind,
      endpointId: row._id.endpointId,
      status: row._id.status,
      count: row.count,
      maxAttemptCount: row.maxAttemptCount
    })),
    exhaustedSamples: exhaustedSamples.map((delivery) => ({
      id: String(delivery._id),
      adapterKind: delivery.adapterKind,
      endpointId: delivery.endpointId,
      eventType: delivery.eventType,
      lastFailureCategory: delivery.lastFailureCategory,
      attemptCount: delivery.attemptCount,
      lastDeliveryReference: delivery.lastDeliveryReference
    }))
  };
}

async function collectRedisEvidence(redis, endpoints) {
  const streams = [];
  for (const endpoint of endpoints) {
    const length = await redis.client.xlen(endpoint.streamKey);
    const entries = await redis.client.xrevrange(endpoint.streamKey, '+', '-', 'COUNT', 2);
    streams.push({
      streamKey: endpoint.streamKey,
      length,
      entries: entries.map(([id, fields]) => ({
        id,
        json: readRedisJsonField(fields)
      }))
    });
  }
  return { streams };
}

function summarizePeakSnapshots(snapshots) {
  let peakQueued = 0;
  let peakRetrying = 0;
  let peakDispatching = 0;
  let peakOldestQueuedAgeMs = 0;
  let peakLargestBacklogShare = 0;

  for (const snapshot of snapshots) {
    const summary = snapshot.nodeA.summary;
    peakQueued = Math.max(peakQueued, summary.deliveryCounts.queued);
    peakRetrying = Math.max(peakRetrying, summary.deliveryCounts.retrying);
    peakDispatching = Math.max(peakDispatching, summary.deliveryCounts.dispatching);
    peakOldestQueuedAgeMs = Math.max(peakOldestQueuedAgeMs, summary.backlogAging.queued);
    peakLargestBacklogShare = Math.max(peakLargestBacklogShare, summary.fairness.largestBacklogEndpointShare);
  }

  return {
    snapshots: snapshots.length,
    peakQueued,
    peakRetrying,
    peakDispatching,
    peakOldestQueuedAgeMs,
    peakLargestBacklogShare
  };
}

function assertRun({ finalSnapshot, fairness, webhookStats, mongoEvidence, redisEvidence }) {
  if (!finalSnapshot) {
    throw new Error('No final diagnostics snapshot was captured');
  }
  if (!fairness.bothNodesParticipated) {
    throw new Error('Distributed fairness evidence did not show both nodes participating in dispatch');
  }
  if (fairness.dominantShare > dominantNodeShareLimit) {
    throw new Error(`One node monopolized dispatch activity (${fairness.dominantShare.toFixed(3)} > ${dominantNodeShareLimit})`);
  }
  if ((webhookStats.routes.fast.requests ?? 0) === 0) {
    throw new Error('Fast webhook endpoint never received a delivery');
  }
  if ((webhookStats.routes.slow.requests ?? 0) === 0) {
    throw new Error('Slow webhook endpoint never received a delivery');
  }
  if ((webhookStats.routes.fail.requests ?? 0) === 0) {
    throw new Error('Failing webhook endpoint never received a delivery');
  }
  if (!mongoEvidence.exhaustedSamples.length) {
    throw new Error('No exhausted deliveries were observed for the failing adapter mix');
  }
  for (const stream of redisEvidence.streams) {
    if (stream.length <= 0) {
      throw new Error(`Redis stream ${stream.streamKey} did not receive any published events`);
    }
  }
}

async function connectMongo() {
  let lastError;
  for (const uri of mongoUriCandidates) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 3_000 });
    try {
      await client.connect();
      await client.db().command({ ping: 1 });
      return { client, connectedUri: uri };
    } catch (error) {
      lastError = error;
      await client.close().catch(() => undefined);
    }
  }
  throw new Error(`Unable to connect to MongoDB for eventing soak validation: ${stringifyError(lastError)}`);
}

async function connectRedis() {
  let lastError;
  for (const url of redisUrlCandidates) {
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true
    });
    try {
      await client.connect();
      await client.ping();
      return { client, connectedUrl: url };
    } catch (error) {
      lastError = error;
      client.disconnect();
    }
  }
  throw new Error(`Unable to connect to Redis for eventing soak validation: ${stringifyError(lastError)}`);
}

async function startWebhookServer() {
  const routes = {
    fast: createRouteStats(),
    slow: createRouteStats(),
    fail: createRouteStats()
  };
  const server = createServer(async (request, response) => {
    const routeKey = normalizeRoute(request.url);
    const routeStats = routes[routeKey];
    if (!routeStats) {
      response.statusCode = 404;
      response.end('not-found');
      return;
    }

    routeStats.requests += 1;
    routeStats.active += 1;
    routeStats.maxConcurrent = Math.max(routeStats.maxConcurrent, routeStats.active);
    try {
      const body = await readRequestBody(request);
      routeStats.lastHeaders = lowerCaseKeys(request.headers);
      routeStats.lastPayload = body ? JSON.parse(body) : undefined;
      if (routeKey === 'slow') {
        await delay(slowWebhookDelayMs);
      }
      response.statusCode = routeKey === 'fail' ? 503 : 204;
      response.end();
    } catch (error) {
      response.statusCode = 500;
      response.end(String(error));
    } finally {
      routeStats.active = Math.max(0, routeStats.active - 1);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(webhookServerPort, webhookListenHost, resolve);
  });

  return {
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    snapshot: () => ({
      listenHost: webhookListenHost,
      port: webhookServerPort,
      baseUrl: webhookEndpointBaseUrl,
      routes
    })
  };
}

function createRouteStats() {
  return {
    requests: 0,
    active: 0,
    maxConcurrent: 0,
    lastHeaders: undefined,
    lastPayload: undefined
  };
}

function normalizeRoute(rawUrl) {
  const url = new URL(rawUrl ?? '/', 'http://127.0.0.1');
  switch (url.pathname) {
    case '/fast':
      return 'fast';
    case '/slow':
      return 'slow';
    case '/fail':
      return 'fail';
    default:
      return undefined;
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
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
  if (!participant?.socket) {
    return;
  }
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

async function getJson(url) {
  const response = await fetch(url, { headers: operatorHeaders() });
  if (!response.ok) {
    throw new Error(`Request failed ${url}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function getText(url) {
  const response = await fetch(url, { headers: operatorHeaders() });
  if (!response.ok) {
    throw new Error(`Request failed ${url}: ${response.status} ${await response.text()}`);
  }
  return response.text();
}

async function postJson(url, accessToken, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...operatorHeaders(accessToken),
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Request failed ${url}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function patchJson(url, accessToken, body) {
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...operatorHeaders(accessToken),
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Request failed ${url}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function operatorHeaders(accessToken) {
  const headers = {};
  if (accessToken) {
    headers.authorization = `Bearer ${accessToken}`;
  }
  if (operationsToken) {
    headers['x-operations-token'] = operationsToken;
  }
  return headers;
}

function summarizeEndpoint(endpoint) {
  return {
    id: endpoint.id,
    adapterKind: endpoint.adapterKind ?? 'webhook',
    name: endpoint.name,
    target: endpoint.url ?? endpoint.streamKey,
    enabled: endpoint.enabled
  };
}

function subtractMetricSnapshot(after, before) {
  return {
    attemptsByAdapter: subtractAdapterRecord(after.attemptsByAdapter, before.attemptsByAdapter),
    executionsByAdapter: subtractAdapterRecord(after.executionsByAdapter, before.executionsByAdapter),
    retriesByAdapter: subtractAdapterRecord(after.retriesByAdapter, before.retriesByAdapter),
    exhaustedByAdapter: subtractAdapterRecord(after.exhaustedByAdapter, before.exhaustedByAdapter)
  };
}

function subtractAdapterRecord(after, before) {
  return {
    webhook: Math.max(0, (after.webhook ?? 0) - (before.webhook ?? 0)),
    'redis-stream': Math.max(0, (after['redis-stream'] ?? 0) - (before['redis-stream'] ?? 0))
  };
}

function sumObject(record) {
  return Object.values(record).reduce((sum, value) => sum + Number(value ?? 0), 0);
}

function metricSumByLabel(text, metricName, expectedLabels) {
  const pattern = new RegExp(`^${metricName}\\{([^}]*)\\}\\s+([-+]?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)$`, 'gmi');
  let match;
  let total = 0;
  while ((match = pattern.exec(text)) !== null) {
    const labels = parseLabels(match[1] ?? '');
    const matches = Object.entries(expectedLabels).every(([key, value]) => labels[key] === value);
    if (matches) {
      total += Number(match[2] ?? 0);
    }
  }
  return total;
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
      cname: `eventing-soak-${seed}`,
      reducedSize: true
    }
  };
}

function readRedisJsonField(fields) {
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index] === 'json') {
      try {
        return JSON.parse(fields[index + 1]);
      } catch {
        return fields[index + 1];
      }
    }
  }
  return undefined;
}

function lowerCaseKeys(record) {
  return Object.fromEntries(
    Object.entries(record ?? {}).map(([key, value]) => [String(key).toLowerCase(), value])
  );
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeUrl(value) {
  return String(value).replace(/\/+$/, '');
}

function parseInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyError(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
