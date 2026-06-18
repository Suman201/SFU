import { test, expect, type Page } from '@playwright/test';
import type { Consumer, Producer, RoomQualityState, TransportOptions } from '@native-sfu/contracts';
import { buildUnifiedPlanAnswer, parseSdpRtpParameters } from '@native-sfu/nest-sfu';
import { randomUUID } from 'node:crypto';
import {
  applyRemoteTransportOverSocket,
  closeStagingBrowserPeers,
  closeStagingSocket,
  connectStagingSocket,
  createStagingPublisherOffer,
  createStagingSubscriberOffer,
  emitAck,
  fetchRoomQuality,
  fetchTurnCredentials,
  loginToStaging,
  publisherOutboundVideoStats,
  readPeerDiagnostics,
  registerInStaging,
  setPublisherAnswer,
  setSubscriberAnswer,
  supportedTurnIceServer,
  waitForInboundVideoFrames,
  waitForPeerConnected,
  type StagingSocket
} from './helpers/staging-browser';

const baseUrl = process.env.STAGING_BASE_URL;
const hostEmail = process.env.STAGING_HOST_EMAIL ?? process.env.STAGING_EMAIL;
const hostPassword = process.env.STAGING_HOST_PASSWORD ?? process.env.STAGING_PASSWORD;
const subscriberEmail = process.env.STAGING_SUBSCRIBER_EMAIL;
const subscriberPassword = process.env.STAGING_SUBSCRIBER_PASSWORD ?? process.env.STAGING_PASSWORD ?? 'Password@12345';
const socketTimeoutMs = parsePositiveInteger(process.env.STAGING_BROWSER_ACK_TIMEOUT_MS, 15_000);

test.describe('staging ingress browser publish/subscribe proof', () => {
  test('chromium browser publishes and subscribes video over the shared staging ingress hostname', async ({ page, browserName }) => {
    test.skip(
      !baseUrl || !hostEmail || !hostPassword,
      'Set STAGING_BASE_URL and STAGING_HOST_EMAIL/STAGING_HOST_PASSWORD (or STAGING_EMAIL/STAGING_PASSWORD) to run the staged ingress browser proof.'
    );
    test.skip(
      browserName !== 'chromium',
      'Staged ingress browser publish/subscribe proof is currently scoped to Chromium. This keeps the real-browser smoke aligned with the newer Chromium VP9-preference path while Firefox and WebKit remain covered by the local browser interop suite.'
    );
    test.skip(
      subscriberEmail ? normalizeEmail(hostEmail) === normalizeEmail(subscriberEmail) : false,
      'Use distinct host and subscriber accounts; the room service replaces a same-user socket instead of creating a second participant.'
    );

    test.setTimeout(120_000);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    const stagingBaseUrl = baseUrl;
    const stagingHostEmail = hostEmail;
    const stagingHostPassword = hostPassword;
    const stagingSubscriberEmail = subscriberEmail;
    const stagingSubscriberPassword = subscriberPassword;

    let hostSocket: StagingSocket | undefined;
    let subscriberSocket: StagingSocket | undefined;
    let roomId: string | undefined;
    let producer: Producer | undefined;
    let consumer: Consumer | undefined;

    try {
      const [hostAuth, subscriberAuth] = await Promise.all([
        loginToStaging(stagingBaseUrl, stagingHostEmail, stagingHostPassword),
        stagingSubscriberEmail
          ? loginToStaging(stagingBaseUrl, stagingSubscriberEmail, stagingSubscriberPassword)
          : registerInStaging(
              stagingBaseUrl,
              `staging-subscriber-${randomUUID()}@example.com`,
              stagingSubscriberPassword,
              'staging-browser-subscriber'
            )
      ]);
      const [hostTurn, subscriberTurn] = await Promise.all([
        fetchTurnCredentials(stagingBaseUrl, hostAuth.accessToken),
        fetchTurnCredentials(stagingBaseUrl, subscriberAuth.accessToken)
      ]);
      const hostIceServer = supportedTurnIceServer(hostTurn);
      const subscriberIceServer = supportedTurnIceServer(subscriberTurn);

      const hostSfuSocket = hostSocket = await connectStagingSocket(stagingBaseUrl, hostAuth.accessToken, socketTimeoutMs);
      const subscriberSfuSocket = subscriberSocket = await connectStagingSocket(stagingBaseUrl, subscriberAuth.accessToken, socketTimeoutMs);

      const room = await emitAck<{ id: string }>(
        hostSfuSocket,
        'room:create',
        {
          name: `staging-browser-proof-${randomUUID().slice(0, 8)}`,
          maxParticipants: 4,
          waitingRoomEnabled: false,
          joinApprovalRequired: false
        },
        socketTimeoutMs
      );
      const createdRoomId = roomId = room.id;

      await emitAck(
        subscriberSfuSocket,
        'room:join',
        {
          roomId: createdRoomId,
          displayName: 'staging-browser-subscriber'
        },
        socketTimeoutMs
      );

      const publisherTransport = await emitAck<TransportOptions>(hostSfuSocket, 'transport:create', { roomId: createdRoomId }, socketTimeoutMs);
      expect(hasReachableServerCandidate(publisherTransport)).toBeTruthy();
      // Prefer Chromium's newer VP9 sender path when available, but keep the claim here to staged publish/subscribe flow.
      const publisherOffer = await createStagingPublisherOffer(page, hostIceServer, 'video/VP9');
      await applyRemoteTransportOverSocket(hostSfuSocket, publisherTransport.id, publisherOffer.sdp, socketTimeoutMs);
      const producerRtp = parseSdpRtpParameters('video', publisherOffer.sdp);
      const createdProducer = producer = await emitAck<Producer>(
        hostSfuSocket,
        'producer:create',
        {
          roomId: createdRoomId,
          kind: 'video',
          transportId: publisherTransport.id,
          rtpParameters: producerRtp
        },
        socketTimeoutMs
      );
      await setPublisherAnswer(
        page,
        buildUnifiedPlanAnswer({
          transport: publisherTransport,
          offer: publisherOffer.sdp,
          direction: 'recvonly',
          mediaKind: 'video',
          rtpParameters: producerRtp
        })
      );

      const subscriberTransport = await emitAck<TransportOptions>(subscriberSfuSocket, 'transport:create', { roomId: createdRoomId }, socketTimeoutMs);
      expect(hasReachableServerCandidate(subscriberTransport)).toBeTruthy();
      const subscriberOffer = await createStagingSubscriberOffer(page, subscriberIceServer);
      await applyRemoteTransportOverSocket(subscriberSfuSocket, subscriberTransport.id, subscriberOffer, socketTimeoutMs);
      const createdConsumer = consumer = await emitAck<Consumer>(
        subscriberSfuSocket,
        'consumer:create',
        {
          roomId: createdRoomId,
          producerId: createdProducer.id,
          transportId: subscriberTransport.id,
          preferredLayer: 'high'
        },
        socketTimeoutMs
      );
      await setSubscriberAnswer(
        page,
        buildUnifiedPlanAnswer({
          transport: subscriberTransport,
          offer: subscriberOffer,
          direction: 'sendonly',
          rtpParameters: createdConsumer.rtpParameters
        })
      );

      await waitForPeerConnected(page, 'publisher', 30_000);
      await waitForPeerConnected(page, 'subscriber', 30_000);

      const decodedFrames = await waitForInboundVideoFrames(page, 5, 30_000);
      expect(decodedFrames).toBeGreaterThanOrEqual(5);

      const outboundVideo = await publisherOutboundVideoStats(page);
      expect(outboundVideo.some((report) => Number(report.packetsSent ?? 0) > 0)).toBeTruthy();

      const publisherDiagnostics = await readPeerDiagnostics(page, 'publisher');
      const subscriberDiagnostics = await readPeerDiagnostics(page, 'subscriber');
      expect(publisherDiagnostics.gatheredCandidateTypes).toContain('relay');
      expect(subscriberDiagnostics.gatheredCandidateTypes).toContain('relay');
      expect(publisherDiagnostics.relayCandidateCount).toBeGreaterThan(0);
      expect(subscriberDiagnostics.relayCandidateCount).toBeGreaterThan(0);

      await expect.poll(async () => {
        const quality = await fetchRoomQuality(hostSfuSocket, createdRoomId, socketTimeoutMs);
        return quality.producers.find((state) => state.producerId === createdProducer.id)?.bitrate.actualBitrate ?? 0;
      }, { timeout: 20_000 }).toBeGreaterThan(0);

      await expect.poll(async () => {
        const quality = await fetchRoomQuality(hostSfuSocket, createdRoomId, socketTimeoutMs);
        const consumerQuality = quality.consumers.find((state) => state.consumerId === createdConsumer.id);
        return Math.max(consumerQuality?.bitrate.actualBitrate ?? 0, consumerQuality?.bitrate.allocatedBitrate ?? 0);
      }, { timeout: 20_000 }).toBeGreaterThan(0);

      const roomQuality = await fetchRoomQuality(hostSfuSocket, createdRoomId, socketTimeoutMs);
      expect(roomQuality.producers.some((state) => state.producerId === createdProducer.id)).toBe(true);
      expect(roomQuality.consumers.some((state) => state.consumerId === createdConsumer.id)).toBe(true);

      if (publisherOffer.codecPreferenceApplied) {
        expect(producerRtp.codecs[0]?.mimeType.toLowerCase()).toBe('video/vp9');
      }
    } catch (error) {
      const details = await collectFailureDiagnostics(page, hostSocket, roomId);
      throw new Error(`${error instanceof Error ? error.message : String(error)}${details ? `\n${details}` : ''}`);
    } finally {
      if (hostSocket && roomId) {
        await emitAck<void>(hostSocket, 'room:close', { roomId }, socketTimeoutMs).catch(() => undefined);
      }
      await closeStagingBrowserPeers(page).catch(() => undefined);
      await closeStagingSocket(subscriberSocket);
      await closeStagingSocket(hostSocket);
    }
  });
});

async function collectFailureDiagnostics(page: Page, socket: StagingSocket | undefined, roomId: string | undefined): Promise<string> {
  const parts: string[] = [];
  try {
    parts.push(`publisherDiagnostics=${JSON.stringify(await readPeerDiagnostics(page, 'publisher'))}`);
  } catch {
    // Best effort diagnostics only.
  }
  try {
    parts.push(`subscriberDiagnostics=${JSON.stringify(await readPeerDiagnostics(page, 'subscriber'))}`);
  } catch {
    // Best effort diagnostics only.
  }
  try {
    parts.push(`publisherOutbound=${JSON.stringify(await publisherOutboundVideoStats(page))}`);
  } catch {
    // Best effort diagnostics only.
  }
  if (socket && roomId) {
    try {
      const quality = await fetchRoomQuality(socket, roomId, socketTimeoutMs);
      parts.push(`roomQuality=${JSON.stringify(summarizeRoomQuality(quality))}`);
    } catch {
      // Best effort diagnostics only.
    }
  }
  return parts.join('\n');
}

function summarizeRoomQuality(quality: RoomQualityState): Record<string, unknown> {
  return {
    score: quality.score.score,
    actualBitrate: quality.actualBitrate,
    producerBitrates: quality.producers.map((state) => ({
      producerId: state.producerId,
      actualBitrate: state.bitrate.actualBitrate,
      allocatedBitrate: state.bitrate.allocatedBitrate
    })),
    consumerBitrates: quality.consumers.map((state) => ({
      consumerId: state.consumerId,
      actualBitrate: state.bitrate.actualBitrate,
      allocatedBitrate: state.bitrate.allocatedBitrate,
      score: state.score.score
    }))
  };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function hasReachableServerCandidate(transport: TransportOptions): boolean {
  return (transport.iceCandidates ?? []).some((candidate) => !isLocalOrWildcardHost(candidate.ip));
}

function isLocalOrWildcardHost(host: string): boolean {
  return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(host.trim().toLowerCase());
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
