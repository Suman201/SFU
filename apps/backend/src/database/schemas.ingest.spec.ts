import { Mongoose } from 'mongoose';
import {
  INGEST_SOURCE_TYPES,
  INGEST_STATUSES,
  INGEST_TRANSPORT_PROTOCOLS,
  PARTICIPANT_ORIGINS,
  PRODUCER_SOURCES
} from '@native-sfu/contracts';
import {
  IngestJobDocument,
  IngestJobSchema,
  ParticipantSchema,
  ProducerSchema
} from './schemas';

describe('Phase 0 ingest schema vocabulary', () => {
  const mongoose = new Mongoose();

  afterAll(async () => {
    await mongoose.disconnect();
  });

  it('widens producer source and participant origin enums without changing existing collections', () => {
    expect(pathOptions(ProducerSchema, 'source').enum).toEqual(PRODUCER_SOURCES);
    expect(pathOptions(ParticipantSchema, 'origin').enum).toEqual(PARTICIPANT_ORIGINS);
    expect(pathOptions(ParticipantSchema, 'origin').default).toBe('user');
  });

  it('defines an ingest job schema with indexed room, status, node, and participant lookup fields', () => {
    expect(pathOptions(IngestJobSchema, 'sourceType').enum).toEqual(INGEST_SOURCE_TYPES);
    expect(pathOptions(IngestJobSchema, 'status').enum).toEqual(INGEST_STATUSES);
    expect(pathOptions(IngestJobSchema, 'status').default).toBe('idle');
    expect(pathOptions(IngestJobSchema, 'transportProtocol').enum).toEqual(INGEST_TRANSPORT_PROTOCOLS);
    expect(pathOptions(IngestJobSchema, 'roomId').index).toBe(true);
    expect(pathOptions(IngestJobSchema, 'participantId').index).toBe(true);
    expect(pathOptions(IngestJobSchema, 'nodeId').index).toBe(true);
  });

  it('serializes ingest-job runtime state and restart policy through the schema', () => {
    const IngestJobModel = mongoose.model<IngestJobDocument>('Phase0IngestJob', IngestJobSchema);
    const document = new IngestJobModel({
      name: 'Room pre-roll',
      displayName: 'System Ingest',
      sourceType: 'hls',
      sourceUrl: 'https://media.example.test/live/index.m3u8',
      roomId: 'room-1',
      participantId: 'participant-system-1',
      nodeId: 'node-a',
      auth: {
        bearerTokenSecretRef: 'vault://media/hls/token',
        headers: [{ name: 'x-origin-token', valueSecretRef: 'vault://media/hls/header-token' }]
      },
      restartPolicy: {
        mode: 'on_failure',
        maxAttempts: 3,
        initialBackoffMs: 1000
      },
      runtimeState: {
        nodeId: 'node-a',
        participantId: 'participant-system-1',
        transportProtocol: 'trusted-rtp-local',
        listenAddress: '127.0.0.1',
        rtpPort: 5004,
        rtcpPort: 5005
      }
    });

    const validationError = document.validateSync();

    expect(validationError).toBeUndefined();
    expect(document.status).toBe('idle');
    expect(document.transportProtocol).toBe('trusted-rtp-local');
    expect(document.runtimeState?.transportProtocol).toBe('trusted-rtp-local');
    expect(document.runtimeState?.rtpPort).toBe(5004);
    expect(document.runtimeState?.rtcpPort).toBe(5005);
    expect(document.restartPolicy?.mode).toBe('on_failure');
    expect(document.restartPolicy?.maxAttempts).toBe(3);
  });
});

function pathOptions(schema: { path: (name: string) => unknown }, name: string): Record<string, unknown> {
  return ((schema.path(name) as { options: Record<string, unknown> } | undefined)?.options ?? {});
}
