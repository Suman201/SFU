import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INGEST_RESTART_MODES,
  INGEST_SOURCE_TYPES,
  INGEST_STATUSES,
  INGEST_TRANSPORT_PROTOCOLS,
  type IngestJob
} from './ingest.js';
import { PARTICIPANT_ORIGINS } from './participants.js';
import { PRODUCER_SOURCES } from './producers.js';

test('ingest vocabulary exports stable literal sets', () => {
  assert.deepEqual(INGEST_SOURCE_TYPES, ['mp4', 'hls', 'rtsp', 'rtmp']);
  assert.deepEqual(INGEST_STATUSES, ['idle', 'starting', 'live', 'restarting', 'stopping', 'stopped', 'failed']);
  assert.deepEqual(INGEST_TRANSPORT_PROTOCOLS, ['trusted-rtp-local']);
  assert.deepEqual(INGEST_RESTART_MODES, ['never', 'always', 'on_failure']);
  assert.deepEqual(PRODUCER_SOURCES, ['screen', 'whiteboard', 'ingest']);
  assert.deepEqual(PARTICIPANT_ORIGINS, ['user', 'system']);
});

test('ingest job payloads serialize cleanly for persistence and transport', () => {
  const job: IngestJob = {
    id: 'ingest-1',
    name: 'Math class opener',
    roomId: 'room-1',
    participantId: 'participant-system-1',
    nodeId: 'node-a',
    displayName: 'Room Ingest',
    sourceType: 'hls',
    sourceUrl: 'https://media.example.test/live/index.m3u8',
    transportProtocol: 'trusted-rtp-local',
    status: 'idle',
    auth: {
      bearerTokenSecretRef: 'vault://media/hls/token',
      headers: [{ name: 'x-origin-token', valueSecretRef: 'vault://media/hls/header-token' }]
    },
    restartPolicy: {
      mode: 'on_failure',
      maxAttempts: 5,
      initialBackoffMs: 1_000,
      maxBackoffMs: 30_000
    },
    runtime: {
      nodeId: 'node-a',
      participantId: 'participant-system-1',
      transportProtocol: 'trusted-rtp-local',
      listenAddress: '127.0.0.1',
      rtpPort: 5004,
      rtcpPort: 5005,
      restartCount: 2
    },
    createdAt: '2026-07-08T10:00:00.000Z',
    updatedAt: '2026-07-08T10:05:00.000Z'
  };

  const serialized = JSON.parse(JSON.stringify(job)) as IngestJob;

  assert.equal(serialized.sourceType, 'hls');
  assert.equal(serialized.transportProtocol, 'trusted-rtp-local');
  assert.equal(serialized.auth?.headers?.[0]?.name, 'x-origin-token');
  assert.equal(serialized.restartPolicy?.mode, 'on_failure');
  assert.equal(serialized.runtime?.rtpPort, 5004);
});
