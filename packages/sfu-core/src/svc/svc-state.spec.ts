import type { Producer } from '@native-sfu/contracts';
import type { BandwidthEstimate } from '../bandwidth/bandwidth-estimator';
import { RtpPacket } from '../rtp/rtp-packet';
import { detectSvcLayer } from '../codecs/svc-layer-detector';
import { ProducerSvcStateTracker } from './svc-state';

describe('ProducerSvcStateTracker', () => {
  it('tracks VP9 SVC availability and selects layers from preference and bitrate', () => {
    const producer = createVp9Producer();
    const state = new ProducerSvcStateTracker(producer, () => 1000);

    expect(state.enabled()).toBe(true);
    expect(producer.svc?.capabilities.codec).toBe('VP9');
    expect(producer.svc?.capabilities.scalabilityMode).toBe('L3T3_KEY');
    expect(producer.svc?.capabilities.spatialLayerCount).toBe(3);
    expect(producer.svc?.capabilities.temporalLayerCount).toBe(3);

    state.markPacket(7777, detectSvcLayer(packet(vp9Payload(0, 0, true)), 'video/VP9'));
    state.markPacket(7777, detectSvcLayer(packet(vp9Payload(2, 2)), 'video/VP9'));

    expect(state.currentLayers()).toEqual({ spatialLayerId: 2, temporalLayerId: 2, qualityLayerId: 2 });
    expect(state.selectLayer(undefined, { spatialLayerId: 1, temporalLayerId: 2 }).selection).toEqual({
      spatialLayerId: 1,
      temporalLayerId: 2,
      qualityLayerId: 1
    });
    expect(state.selectLayer(estimate(300_000), { spatialLayerId: 2, temporalLayerId: 2 }).selection).toEqual({
      spatialLayerId: 0,
      temporalLayerId: 0,
      qualityLayerId: 0
    });
  });

  it('keeps multi-encoding simulcast producers out of the SVC path', () => {
    const producer = createVp9Producer();
    producer.rtpParameters.encodings.push({ rid: 'high', ssrc: 8888, spatialLayer: 1 });

    expect(new ProducerSvcStateTracker(producer).enabled()).toBe(false);
  });

  it('ages out stale top SVC layers and reselects an active lower layer without BWE', () => {
    let now = 1000;
    const producer = createVp9Producer();
    const state = new ProducerSvcStateTracker(producer, () => now, 50);

    state.markPacket(7777, detectSvcLayer(packet(vp9Payload(2, 2, true)), 'video/VP9'));
    expect(state.currentLayers()).toEqual({ spatialLayerId: 2, temporalLayerId: 2, qualityLayerId: 2 });

    now = 1100;
    state.markPacket(7777, detectSvcLayer(packet(vp9Payload(0, 0, true)), 'video/VP9'));

    expect(state.currentLayers()).toEqual({ spatialLayerId: 0, temporalLayerId: 0, qualityLayerId: 0 });
    expect(state.isActive({ spatialLayerId: 2, temporalLayerId: 2, qualityLayerId: 2 })).toBe(false);
  });
});

function createVp9Producer(): Producer {
  return {
    id: 'producer-1',
    participantId: 'publisher',
    roomId: 'room-1',
    kind: 'video',
    transportId: 'transport-pub',
    status: 'live',
    createdAt: new Date().toISOString(),
    rtpParameters: {
      codecs: [{ mimeType: 'video/VP9', payloadType: 98, clockRate: 90000, parameters: { 'scalability-mode': 'L3T3_KEY' } }],
      encodings: [{ ssrc: 7777, maxBitrate: 2_700_000, scalabilityMode: 'L3T3_KEY' }],
      rtcp: { cname: 'producer', reducedSize: true }
    }
  };
}

function packet(payload: Buffer): RtpPacket {
  return new RtpPacket(2, false, false, false, 98, 1, 1000, 7777, [], null, payload);
}

function vp9Payload(spatialLayer: number, temporalLayer: number, keyframe = false): Buffer {
  return Buffer.from([(keyframe ? 0x2c : 0x6c), ((temporalLayer & 0x07) << 5) | ((spatialLayer & 0x07) << 1) | (spatialLayer > 0 ? 0x01 : 0), 0x00, 0x10]);
}

function estimate(recommendedBitrate: number): BandwidthEstimate {
  return {
    id: 'consumer-1',
    estimatedIncomingBitrate: 0,
    estimatedOutgoingBitrate: recommendedBitrate,
    availableBitrate: recommendedBitrate,
    recommendedBitrate,
    packetLoss: 0,
    rtt: 0,
    rttVariance: 0,
    jitter: 0,
    delayVariationMs: 0,
    delayTrend: 0,
    overuseState: 'normal',
    probeBitrate: 0,
    lossCorrelation: 0,
    updatedAt: 1000
  };
}
