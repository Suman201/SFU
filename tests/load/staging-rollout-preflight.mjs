const nodeAUrl = process.env.NODE_A_URL ?? process.env.STAGING_BASE_URL ?? 'http://127.0.0.1:3000';
const nodeBUrl = process.env.NODE_B_URL ?? '';
const operationsToken = process.env.OPERATIONS_TOKEN;
const stagingEmail = process.env.STAGING_EMAIL;
const stagingPassword = process.env.STAGING_PASSWORD;
const expectDistributed = process.env.EXPECT_DISTRIBUTED === 'true';
const expectPipeEnabled = process.env.EXPECT_PIPE_ENABLED === 'true';
const eventLoopMeanThresholdMs = parseThreshold(process.env.EVENT_LOOP_MEAN_THRESHOLD_MS, 50);
const eventLoopMaxThresholdMs = parseThreshold(process.env.EVENT_LOOP_MAX_THRESHOLD_MS, 250);

async function main() {
  const failedChecks = [];
  const nodeUrls = [nodeAUrl, nodeBUrl].filter((value, index, list) => value && list.indexOf(value) === index);
  const nodes = [];

  for (const baseUrl of nodeUrls) {
    const nodeReport = await inspectNode(baseUrl, failedChecks);
    nodes.push(nodeReport);
  }

  let turnCredentials = {
    skipped: true,
    reason: 'Set STAGING_EMAIL and STAGING_PASSWORD to validate TURN credentials and browser relay readiness.'
  };
  if (stagingEmail && stagingPassword) {
    turnCredentials = await inspectTurnCredentials(nodeAUrl, failedChecks);
  }

  if (expectDistributed && nodes.length > 0) {
    const registeredNodes = nodes[0]?.metrics?.clusterRegisteredNodes ?? 0;
    if (registeredNodes < 2) {
      failedChecks.push(`expected at least 2 registered cluster nodes, received ${registeredNodes}`);
    }
  }

  if (expectPipeEnabled) {
    for (const node of nodes) {
      if (!node.pipe.enabled) {
        failedChecks.push(`${node.baseUrl} pipe transport is not enabled`);
      }
      if (!node.pipe.supported) {
        failedChecks.push(`${node.baseUrl} pipe transport is not supported (${node.pipe.reason ?? 'unknown'})`);
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    thresholds: {
      eventLoopMeanThresholdMs,
      eventLoopMaxThresholdMs
    },
    nodes,
    turnCredentials,
    controlledRolloutReady: failedChecks.length === 0,
    failedChecks
  };

  console.log(JSON.stringify(report, null, 2));
  if (failedChecks.length > 0) {
    process.exitCode = 1;
  }
}

async function inspectNode(baseUrl, failedChecks) {
  const [live, ready, metricsWithToken, metricsWithoutToken, diagnostics, workers] = await Promise.all([
    fetch(`${baseUrl}/health/live`),
    fetch(`${baseUrl}/health/ready`),
    fetch(`${baseUrl}/metrics`, { headers: operationsHeaders(true) }),
    fetch(`${baseUrl}/metrics`),
    getJson(`${baseUrl}/api/v1/media/diagnostics/node`, true),
    getJson(`${baseUrl}/api/v1/media/workers`, true)
  ]);

  const metricsText = metricsWithToken.ok ? await metricsWithToken.text() : '';
  const liveStatus = live.status;
  const readyStatus = ready.status;
  const operatorTokenProtected = operationsToken ? metricsWithoutToken.status === 401 : false;

  if (liveStatus !== 200) {
    failedChecks.push(`${baseUrl} live health returned ${liveStatus}`);
  }
  if (readyStatus !== 200) {
    failedChecks.push(`${baseUrl} ready health returned ${readyStatus}`);
  }
  if (!metricsWithToken.ok) {
    failedChecks.push(`${baseUrl} metrics with operator token returned ${metricsWithToken.status}`);
  }
  if (operationsToken && !operatorTokenProtected) {
    failedChecks.push(`${baseUrl} metrics endpoint did not enforce X-Operations-Token`);
  }
  if (!diagnostics.trafficReady) {
    failedChecks.push(`${baseUrl} node diagnostics reported trafficReady=false`);
  }
  if (diagnostics.turn?.requiredInProduction && (!diagnostics.turn.secretConfigured || diagnostics.turn.supportedUriCount === 0)) {
    failedChecks.push(`${baseUrl} TURN diagnostics are not production-ready`);
  }
  if ((diagnostics.turn?.localhostUriCount ?? 0) > 0) {
    failedChecks.push(`${baseUrl} TURN diagnostics still advertise localhost relay URIs`);
  }
  if (diagnostics.turn?.uriCount > 0 && !diagnostics.turn?.udpOnly) {
    failedChecks.push(`${baseUrl} TURN diagnostics still advertise unsupported TURN transports`);
  }
  if (!isLocalOrWildcardUrl(baseUrl) && diagnostics.addressing?.publicUrlIsLocalOrWildcard) {
    failedChecks.push(`${baseUrl} diagnostics still advertise a localhost/wildcard PUBLIC_URL (${diagnostics.addressing.publicUrl})`);
  }
  if (!isLocalOrWildcardUrl(baseUrl) && diagnostics.addressing?.nodePublicUrlIsLocalOrWildcard) {
    failedChecks.push(`${baseUrl} diagnostics still advertise a localhost/wildcard NODE_PUBLIC_URL (${diagnostics.addressing.nodePublicUrl})`);
  }
  if (diagnostics.ice?.announcedAddressIsLocalOrWildcard) {
    failedChecks.push(`${baseUrl} diagnostics still advertise a localhost/wildcard ICE announced address (${diagnostics.ice.announcedAddress})`);
  }
  if ((diagnostics.ice?.stunServerHosts ?? []).some((host) => isLocalOrWildcardHost(host))) {
    failedChecks.push(`${baseUrl} diagnostics still point ICE_STUN_SERVERS at localhost or wildcard hosts`);
  }
  if ((diagnostics.ice?.turnServerHosts ?? []).some((host) => isLocalOrWildcardHost(host))) {
    failedChecks.push(`${baseUrl} diagnostics still point ICE_TURN_SERVERS at localhost or wildcard hosts`);
  }
  if ((diagnostics.ice?.stunServerCount ?? 0) > (diagnostics.ice?.supportedStunServerCount ?? 0)) {
    failedChecks.push(`${baseUrl} diagnostics still advertise unsupported STUN server transports`);
  }
  if ((diagnostics.ice?.turnServerCount ?? 0) > (diagnostics.ice?.supportedTurnServerCount ?? 0)) {
    failedChecks.push(`${baseUrl} diagnostics still advertise unsupported server-side TURN transports`);
  }

  const refreshStatus = {
    cluster: metricLabelValue(metricsText, 'sfu_metrics_refresh_status', { component: 'cluster' }),
    pipe: metricLabelValue(metricsText, 'sfu_metrics_refresh_status', { component: 'pipe' }),
    mediaWorkers: metricLabelValue(metricsText, 'sfu_metrics_refresh_status', { component: 'media_workers' })
  };
  for (const [component, status] of Object.entries(refreshStatus)) {
    if (status !== undefined && status < 1) {
      failedChecks.push(`${baseUrl} metrics refresh status is unhealthy for ${component}`);
    }
  }

  const eventLoop = {
    meanMs: secondsToMs(metricValue(metricsText, 'nodejs_eventloop_lag_mean_seconds')),
    maxMs: secondsToMs(metricValue(metricsText, 'nodejs_eventloop_lag_max_seconds'))
  };
  if (eventLoop.meanMs !== undefined && eventLoop.meanMs > eventLoopMeanThresholdMs) {
    failedChecks.push(`${baseUrl} event-loop mean lag ${eventLoop.meanMs}ms exceeded ${eventLoopMeanThresholdMs}ms`);
  }
  if (eventLoop.maxMs !== undefined && eventLoop.maxMs > eventLoopMaxThresholdMs) {
    failedChecks.push(`${baseUrl} event-loop max lag ${eventLoop.maxMs}ms exceeded ${eventLoopMaxThresholdMs}ms`);
  }

  const workerSummary = {
    mode: workers.mode,
    workerCount: workers.workerCount,
    readyWorkers: workers.readyWorkers,
    healthyWorkers: workers.healthyWorkers,
    drainingWorkers: workers.drainingWorkers,
    overloadedWorkers: workers.overloadedWorkers,
    failedRooms: workers.failedRooms,
    totalRssBytes: (workers.workers ?? []).reduce((total, worker) => total + (worker.memory?.rss ?? 0), 0),
    totalHeapUsedBytes: (workers.workers ?? []).reduce((total, worker) => total + (worker.memory?.heapUsed ?? 0), 0),
    totalCpuUserMicros: (workers.workers ?? []).reduce((total, worker) => total + (worker.cpu?.user ?? 0), 0),
    maxQueueDepth: (workers.workers ?? []).reduce((max, worker) => Math.max(max, worker.queueDepth ?? 0), 0),
    maxIpcLatencyMs: (workers.workers ?? []).reduce((max, worker) => Math.max(max, worker.averageIpcLatencyMs ?? 0), 0)
  };
  if (workers.workerCount > 0 && workers.readyWorkers < workers.workerCount) {
    failedChecks.push(`${baseUrl} readyWorkers ${workers.readyWorkers}/${workers.workerCount}`);
  }
  if ((workers.failedRooms ?? []).length > 0) {
    failedChecks.push(`${baseUrl} worker pool reported failed rooms: ${(workers.failedRooms ?? []).join(', ')}`);
  }

  return {
    baseUrl,
    health: {
      liveStatus,
      readyStatus
    },
    operatorToken: {
      configuredOnClient: Boolean(operationsToken),
      metricsWithoutTokenStatus: metricsWithoutToken.status,
      metricsWithTokenStatus: metricsWithToken.status,
      enforced: operatorTokenProtected
    },
    diagnostics: {
      localNodeId: diagnostics.localNodeId,
      trafficReady: diagnostics.trafficReady,
      alerts: diagnostics.alerts,
      clusterHealth: diagnostics.cluster?.localNode?.health,
      draining: diagnostics.cluster?.localNode?.draining,
      capacity: diagnostics.cluster?.localNode?.capacity,
      turn: diagnostics.turn,
      ice: diagnostics.ice,
      addressing: diagnostics.addressing
    },
    pipe: {
      enabled: diagnostics.pipe?.health?.enabled,
      durable: diagnostics.pipe?.health?.durable,
      supported: diagnostics.pipe?.health?.supported,
      mediaWorkerMode: diagnostics.pipe?.health?.mediaWorkerMode,
      advertiseIpConfigured: diagnostics.pipe?.health?.advertiseIpConfigured,
      defaultProtocol: diagnostics.pipe?.health?.defaultProtocol,
      reason: diagnostics.pipe?.health?.reason,
      activePipeTransports: diagnostics.pipe?.summary?.activePipeTransports,
      rejectedRequests: diagnostics.pipe?.summary?.rejectedRequests
    },
    workers: workerSummary,
    metrics: {
      clusterRegisteredNodes: metricValue(metricsText, 'sfu_cluster_registered_nodes'),
      clusterHealthyNodes: metricValue(metricsText, 'sfu_cluster_healthy_nodes'),
      clusterDrainingNodes: metricValue(metricsText, 'sfu_cluster_draining_nodes'),
      clusterOwnedRooms: metricValue(metricsText, 'sfu_cluster_owned_rooms'),
      activeRooms: metricValue(metricsText, 'sfu_active_rooms'),
      activeTransports: metricValue(metricsText, 'sfu_active_transports'),
      activeConsumers: metricValue(metricsText, 'sfu_active_consumers'),
      activePipeTransports: metricValue(metricsText, 'sfu_pipe_transports_active'),
      workerFailedRooms: metricValue(metricsText, 'sfu_media_worker_failed_rooms'),
      processResidentMemoryBytes: metricValue(metricsText, 'process_resident_memory_bytes'),
      processCpuUserSeconds: metricValue(metricsText, 'process_cpu_user_seconds_total'),
      processCpuSystemSeconds: metricValue(metricsText, 'process_cpu_system_seconds_total'),
      eventLoop,
      metricsRefreshStatus: refreshStatus,
      metricsRefreshFailures: {
        cluster: metricLabelValue(metricsText, 'sfu_metrics_refresh_failures_total', { component: 'cluster' }),
        pipe: metricLabelValue(metricsText, 'sfu_metrics_refresh_failures_total', { component: 'pipe' }),
        mediaWorkers: metricLabelValue(metricsText, 'sfu_metrics_refresh_failures_total', { component: 'media_workers' })
      }
    }
  };
}

async function inspectTurnCredentials(baseUrl, failedChecks) {
  const loginResponse = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: stagingEmail, password: stagingPassword })
  });
  if (!loginResponse.ok) {
    failedChecks.push(`TURN credential login failed on ${baseUrl}: ${loginResponse.status}`);
    return {
      skipped: false,
      ok: false,
      loginStatus: loginResponse.status
    };
  }

  const auth = await loginResponse.json();
  const turnResponse = await fetch(`${baseUrl}/api/v1/media/turn-credentials`, {
    headers: {
      authorization: `Bearer ${auth.accessToken}`
    }
  });
  if (!turnResponse.ok) {
    failedChecks.push(`TURN credentials endpoint failed on ${baseUrl}: ${turnResponse.status}`);
    return {
      skipped: false,
      ok: false,
      turnStatus: turnResponse.status
    };
  }

  const credentials = await turnResponse.json();
  const uris = Array.isArray(credentials.uris) ? credentials.uris : [];
  const unsupportedUris = uris.filter((uri) => !isSupportedTurnUri(uri));
  if (uris.length === 0) {
    failedChecks.push(`${baseUrl} TURN credentials returned zero URIs`);
  }
  if (unsupportedUris.length > 0) {
    failedChecks.push(`${baseUrl} TURN credentials returned unsupported URIs: ${unsupportedUris.join(', ')}`);
  }

  return {
    skipped: false,
    ok: unsupportedUris.length === 0 && uris.length > 0,
    usernamePresent: Boolean(credentials.username),
    credentialPresent: Boolean(credentials.credential),
    ttl: credentials.ttl,
    uriCount: uris.length,
    uris,
    unsupportedUris
  };
}

async function getJson(url, operatorOnly) {
  const response = await fetch(url, { headers: operationsHeaders(operatorOnly) });
  if (!response.ok) {
    throw new Error(`Request failed ${url}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function operationsHeaders(includeToken) {
  const headers = {};
  if (includeToken && operationsToken) {
    headers['x-operations-token'] = operationsToken;
  }
  return headers;
}

function parseThreshold(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function metricValue(text, metricName) {
  const pattern = new RegExp(`^${escapeForRegex(metricName)}(?:\\{[^}]*\\})?\\s+([-+]?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)$`, 'gmi');
  const match = pattern.exec(text);
  return match ? Number(match[1] ?? 0) : undefined;
}

function metricLabelValue(text, metricName, expectedLabels) {
  const pattern = new RegExp(`^${escapeForRegex(metricName)}\\{([^}]*)\\}\\s+([-+]?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)$`, 'gmi');
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

function escapeForRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSupportedTurnUri(uri) {
  const normalized = String(uri).trim().toLowerCase();
  return normalized.startsWith('turn:') && normalized.includes('transport=udp') && !normalized.startsWith('turns:') && !normalized.includes('transport=tcp');
}

function isLocalOrWildcardUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(hostname);
  } catch {
    return false;
  }
}

function isLocalOrWildcardHost(host) {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(String(host).trim().toLowerCase());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
