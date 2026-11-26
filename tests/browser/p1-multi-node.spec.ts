import { expect, test } from '@playwright/test';
import { io, type Socket } from 'socket.io-client';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { startLocalUiStack } from './helpers/local-ui-stack';
import { seedClassroom, login } from './helpers/whiteboard-classroom';

test('multi-node privacy, drain, reconnect and bounded control-plane soak', async ({}, info) => {
  test.setTimeout(300000);
  const stack = await startLocalUiStack({ frontendPort: 4518, frontendDir: process.env.P0_FRONTEND_DIR, nodePorts: [3418, 3420], workerMode: 'worker', pipeEnabled: true, nodePrefix: 'p1', operationsToken: 'p1-local-operations-fixture-token-32characters' });
  const sockets: Socket[] = [];
  const output = path.resolve('reports/p1/multi-node'); await mkdir(output, { recursive: true });
  const evidence: any = { generatedAt: new Date().toISOString(), realBackendProcesses: 2, realRedisFanout: true, environment: 'isolated-local', productionSignoff: false, passed: false, checks: {} };
  const api = async (base: string, token: string, endpoint: string, method = 'GET', body?: any) => {
    const response = await fetch(base + endpoint, { method, headers: { authorization: 'Bearer ' + token, 'x-operations-token': stack.operationsToken, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    expect(response.ok, endpoint + ': ' + response.status).toBe(true); const json = await response.json(); return json.data ?? json;
  };
  const connect = async (base: string, token: string) => {
    const socket = io(base + '/sfu', { transports: ['websocket'], auth: { token }, reconnection: false }); sockets.push(socket);
    await new Promise<void>((resolve, reject) => { const timeout = setTimeout(() => reject(Error('Socket connect timed out')), 10000); socket.once('connect', () => { clearTimeout(timeout); resolve(); }); socket.once('connect_error', error => { clearTimeout(timeout); reject(error); }); });
    return socket;
  };
  const ack = (socket: Socket, event: string, payload: any) => new Promise<any>((resolve, reject) => socket.timeout(10000).emit(event, payload, (error: Error | null, result: any) => { if (error) reject(error); else if (result?.ok) resolve(result.data); else reject(Error(event + ': ' + (result?.error?.message || 'request failed'))); }));
  const events = (socket: Socket) => { const received: Array<{ event: string; payload: any }> = []; socket.onAny((event, ...args) => received.push({ event, payload: args[0] })); return received; };
  let classRoom = '', otherRoom = '', host: Socket | undefined, otherHost: Socket | undefined;
  let teacherToken = '', fixture: Awaited<ReturnType<typeof seedClassroom>> | undefined;
  try {
    fixture = await seedClassroom({ batchName: 'P1 acceptance ' + randomUUID() });
    const connection = await mongoose.createConnection(process.env.MONGODB_URI!).asPromise();
    try {
      const db = connection.db!;
      // Dedicated synthetic legacy hosts are needed by the generic room soak API.
      await db.collection('users').updateMany({ email: { $in: ['teacher.one@example.com', 'teacher.two@example.com'] } }, { $addToSet: { roles: 'HOST' } });
      const peer = await db.collection('users').findOne({ email: 'student.two@example.com' });
      const batch = await db.collection('batches').findOne({ _id: fixture.batchId as any });
      await db.collection('student_enrollments').insertOne({ _id: randomUUID() as any, studentId: String(peer!._id), studentName: peer!.name, studentEmail: peer!.email, batchId: fixture.batchId, teacherId: batch!.teacherId, status: 'active', enrolledAt: new Date(), createdAt: new Date() });
    } finally { await connection.close(); }
    const teacher = await login(stack.nodeAUrl, 'teacher.one@example.com', 'Password@12345'); teacherToken = teacher.accessToken;
    const teacher2 = await login(stack.nodeBUrl!, 'teacher.two@example.com', 'Password@12345');
    const student1 = await login(stack.nodeAUrl, 'student.one@example.com', 'Password@12345');
    const student2 = await login(stack.nodeAUrl, 'student.two@example.com', 'Password@12345');
    const outsider = await login(stack.nodeBUrl!, 'student.three@example.com', 'Password@12345');
    const incompatible = await fetch(stack.nodeAUrl + '/api/v1/media/transport-capabilities', { headers: { authorization: 'Bearer ' + teacherToken, 'x-sfu-protocol-version': '999' } });
    expect(incompatible.status).toBe(426);
    const rejectedSocket = io(stack.nodeBUrl! + '/sfu', { transports: ['websocket'], auth: { token: teacherToken, protocolVersion: 999 }, reconnection: false });
    sockets.push(rejectedSocket);
    const rejection = await new Promise<string>((resolve, reject) => { const timer = setTimeout(() => reject(Error('Incompatible socket was not rejected')), 10000); rejectedSocket.once('connect_error', error => { clearTimeout(timer); resolve(error.message); }); rejectedSocket.once('connect', () => { clearTimeout(timer); reject(Error('Incompatible socket connected')); }); });
    expect(rejection).toContain('update the app'); rejectedSocket.disconnect();
    evidence.checks.incompatibleHttpAndSocketClientsBlocked = true;
    classRoom = (await api(stack.nodeAUrl, teacherToken, '/api/v1/class-sessions/' + fixture.sessionId + '/start', 'POST', { batchId: fixture.batchId })).roomId;
    host = await connect(stack.nodeAUrl, teacherToken); await ack(host, 'room:join', { roomId: classRoom });
    let remote = await connect(stack.nodeBUrl!, student1.accessToken);
    const remoteJoin = await ack(remote, 'room:join', { roomId: classRoom });
    const peer = await connect(stack.nodeAUrl, student2.accessToken); await ack(peer, 'room:join', { roomId: classRoom });
    otherHost = await connect(stack.nodeBUrl!, teacher2.accessToken);
    otherRoom = (await ack(otherHost, 'room:create', { name: 'Unrelated P1 class', maxParticipants: 6, waitingRoomEnabled: false, joinApprovalRequired: false })).id;
    const unrelated = await connect(stack.nodeBUrl!, outsider.accessToken); await ack(unrelated, 'room:join', { roomId: otherRoom });
    const hostEvents = events(host), remoteEvents = events(remote), peerEvents = events(peer), unrelatedEvents = events(unrelated);
    const marker = 'private-cross-node-' + randomUUID();
    const firstPrivate = await ack(remote, 'chat:send', { roomId: classRoom, scope: 'private', message: marker });
    await expect.poll(() => hostEvents.some(event => event.event === 'chat:message' && event.payload.message === marker)).toBe(true);
    const reply = await ack(host, 'chat:send', { roomId: classRoom, scope: 'private', recipientId: remoteJoin.participantId, message: 'Teacher private reply ' + marker });
    await expect.poll(() => remoteEvents.some(event => event.event === 'chat:message' && event.payload.id === reply.id)).toBe(true);
    await ack(remote, 'chat:mark-read', { sessionId: fixture.sessionId, roomId: classRoom, scope: 'private', readAt: reply.createdAt });
    await expect.poll(() => hostEvents.some(event => event.event === 'chat:read')).toBe(true);
    await ack(host, 'whiteboard:grant-control', { roomId: classRoom, participantId: remoteJoin.participantId, permissionLevel: 'draw' });
    await expect.poll(() => remoteEvents.some(event => event.event === 'whiteboard:control-granted')).toBe(true);
    await ack(host, 'student:mute-mic', { roomId: classRoom, participantId: remoteJoin.participantId });
    await expect.poll(() => remoteEvents.some(event => event.event === 'student:media-moderated')).toBe(true);
    await ack(host, 'chat:send', { roomId: classRoom, scope: 'broadcast', message: 'Class-only broadcast ' + marker });
    await expect.poll(() => peerEvents.some(event => event.event === 'chat:message' && event.payload.scope === 'broadcast')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 400));
    for (const received of [peerEvents, unrelatedEvents]) {
      expect(received.filter(event => event.event === 'chat:message' && event.payload.scope === 'private')).toEqual([]);
      expect(received.filter(event => ['chat:read', 'whiteboard:control-granted', 'student:media-moderated'].includes(event.event))).toEqual([]);
    }
    expect(unrelatedEvents.filter(event => event.event === 'chat:message')).toEqual([]);
    evidence.checks.privateChatReadControlModerationIsolation = true;
    await api(stack.nodeBUrl!, teacher2.accessToken, '/api/v1/media/node/drain', 'POST', { reason: 'isolated-p1-drill' });
    expect((await fetch(stack.nodeBUrl! + '/health/ready')).status).toBe(503);
    expect((await fetch(stack.nodeBUrl! + '/health/live')).status).toBe(200);
    let rejected = false; try { await ack(otherHost, 'room:create', { name: 'Must reject on drained node' }); } catch { rejected = true; }
    expect(rejected).toBe(true);
    const duringDrain = 'Message while ingress node drains ' + marker;
    await ack(remote, 'chat:send', { roomId: classRoom, scope: 'private', message: duringDrain });
    await expect.poll(() => hostEvents.some(event => event.event === 'chat:message' && event.payload.message === duringDrain)).toBe(true);
    await api(stack.nodeBUrl!, teacher2.accessToken, '/api/v1/media/node/undrain', 'POST', {});
    await expect.poll(async () => (await fetch(stack.nodeBUrl! + '/health/ready')).status).toBe(200);
    remote.disconnect(); remote = await connect(stack.nodeBUrl!, student1.accessToken);
    const rejoined = await ack(remote, 'room:join', { roomId: classRoom });
    expect(rejoined.room.participants.find((item: any) => item.id === rejoined.participantId)?.userId).toBe(remoteJoin.room.participants.find((item: any) => item.id === remoteJoin.participantId)?.userId);
    const afterReconnect = 'Private message after reconnect ' + marker;
    const afterReconnectMessage = await ack(remote, 'chat:send', { roomId: classRoom, scope: 'private', message: afterReconnect });
    expect(afterReconnectMessage.threadKey).toBe(firstPrivate.threadKey);
    await expect.poll(() => hostEvents.some(event => event.event === 'chat:message' && event.payload.message === afterReconnect)).toBe(true);
    evidence.checks.drainRejectsNewWorkPreservesExistingAndReconnects = true;
    await api(stack.nodeAUrl, teacherToken, '/api/v1/class-sessions/' + fixture.sessionId + '/end', 'POST', { batchId: fixture.batchId }); classRoom = '';
    await ack(otherHost, 'room:close', { roomId: otherRoom }); otherRoom = '';
    for (const socket of sockets) socket.disconnect();
    const reportFile = path.join(output, 'bounded-soak.json');
    const result = await promisify(execFile)(process.execPath, ['tests/load/live-soak-signoff.mjs'], { cwd: process.cwd(), env: { ...process.env, NODE_A_URL: stack.nodeAUrl, NODE_B_URL: stack.nodeBUrl!, OPERATIONS_TOKEN: stack.operationsToken, SEED_USER_PASSWORD: 'Password@12345', CAPACITY_STEPS: '2,4', SOAK_CYCLES: '3', SOAK_ROOMS: '2', STABILIZE_MS: '150', BASELINE_TIMEOUT_MS: '30000', EXPECT_DISTRIBUTED: 'true', EXPECT_PIPE_ENABLED: 'true', ENABLE_WORKER_CRASH_VALIDATION: 'true', REPORT_FILE: reportFile }, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(info.outputPath('soak-runtime.log'), result.stdout + result.stderr);
    const soak = JSON.parse(await readFile(reportFile, 'utf8'));
    expect(soak.result.passed, JSON.stringify(soak.result)).toBe(true);
    expect(soak.workerCrash.killedWorkerId).toBeTruthy();
    for (const node of [soak.finalBaseline.nodeA, soak.finalBaseline.nodeB]) {
      expect(node.workers.workers.every((worker: any) => worker.activeRooms === 0 && worker.activeTransports === 0)).toBe(true);
    }
    evidence.checks.boundedControlPlaneSoak = { cycles: 3, roomSteps: [2, 4], passed: true, workerCrashRecovery: true, productionCapacity: 'not established; no sustained browser RTP workload' };
    evidence.passed = true;
  } catch (error) { evidence.error = error instanceof Error ? error.message : String(error); throw error; }
  finally {
    if (classRoom && fixture) await api(stack.nodeAUrl, teacherToken, '/api/v1/class-sessions/' + fixture.sessionId + '/end', 'POST', { batchId: fixture.batchId }).catch(() => undefined);
    if (otherRoom && otherHost?.connected) await ack(otherHost, 'room:close', { roomId: otherRoom }).catch(() => undefined);
    for (const socket of sockets) socket.disconnect();
    await writeFile(path.join(output, 'multi-node.json'), JSON.stringify(evidence, null, 2));
    await writeFile(info.outputPath('backend-runtime.log'), stack.getLogs());
    await stack.stop();
  }
});
