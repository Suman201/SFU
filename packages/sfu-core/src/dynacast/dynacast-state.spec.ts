import type { Consumer, Producer, RtpLayerInfo } from '@native-sfu/contracts';
import { ProducerDynacastDemandState } from './dynacast-state';

describe('ProducerDynacastDemandState', () => {
  it('marks all video simulcast layers suspended when no consumers demand them', () => {
    const producer = createProducer();
    const state = new ProducerDynacastDemandState(producer, { now: () => 1000 });
    state.setAvailableLayers(availableLayers(), 'initial');

    const snapshot = state.snapshot();

    expect(snapshot.enabled).toBe(true);
    expect(snapshot.desiredLayers).toEqual([]);
    expect(snapshot.suspendedLayers).toEqual([{ spatialLayer: 0, temporalLayer: undefined }, { spatialLayer: 1, temporalLayer: undefined }, { spatialLayer: 2, temporalLayer: undefined }]);
    expect(snapshot.estimatedBandwidthSavedBps).toBe(3_650_000);
  });

  it('aggregates consumer demand, expands temporal dependencies, and diffs changes', () => {
    const producer = createProducer();
    const state = new ProducerDynacastDemandState(producer, { now: () => 1000 });
    state.setAvailableLayers(availableLayers(), 'initial');

    const lowChange = state.updateConsumer(createConsumer('consumer-low', { spatialLayer: 0, temporalLayer: 0 }), 'consumer_joined');
    expect(lowChange?.neededLayers).toEqual([{ spatialLayer: 0, temporalLayer: 0 }]);
    expect(lowChange?.unneededLayers).toEqual([]);
    expect(lowChange?.state.highestRequiredSpatialLayer).toBe(0);
    expect(lowChange?.state.highestRequiredTemporalLayer).toBe(0);

    expect(state.updateConsumer(createConsumer('consumer-low', { spatialLayer: 0, temporalLayer: 0 }), 'preferred_layers')).toBeUndefined();

    const highChange = state.updateConsumer(createConsumer('consumer-high', { spatialLayer: 2, temporalLayer: 2 }), 'consumer_joined');
    expect(highChange?.neededLayers).toEqual([
      { spatialLayer: 2, temporalLayer: 0 },
      { spatialLayer: 2, temporalLayer: 1 },
      { spatialLayer: 2, temporalLayer: 2 }
    ]);
    expect(highChange?.state.desiredLayers).toEqual([
      { spatialLayer: 0, temporalLayer: 0 },
      { spatialLayer: 2, temporalLayer: 0 },
      { spatialLayer: 2, temporalLayer: 1 },
      { spatialLayer: 2, temporalLayer: 2 }
    ]);
    expect(highChange?.state.layers.find((layer) => layer.layer.spatialLayer === 2)?.consumerIds).toEqual(['consumer-high']);
    expect(highChange?.state.layerResumeCount).toBe(4);
  });

  it('updates demand for pause, resume, leave, and audio disabled cases', () => {
    const producer = createProducer();
    const state = new ProducerDynacastDemandState(producer);
    state.setAvailableLayers(availableLayers(), 'initial');
    state.updateConsumer(createConsumer('consumer-high', { spatialLayer: 2 }), 'consumer_joined');

    const pause = state.updateConsumerLayers('consumer-high', { spatialLayer: 2 }, { spatialLayer: 2 }, { spatialLayer: 2 }, true, 'consumer_paused');
    expect(pause?.unneededLayers).toEqual([{ spatialLayer: 2, temporalLayer: undefined }]);
    expect(pause?.state.desiredLayers).toEqual([]);

    const resume = state.updateConsumerLayers('consumer-high', { spatialLayer: 2 }, { spatialLayer: 2 }, { spatialLayer: 2 }, false, 'consumer_resumed');
    expect(resume?.neededLayers).toEqual([{ spatialLayer: 2, temporalLayer: undefined }]);
    expect(resume?.state.layerSuspendCount).toBe(1);

    const leave = state.removeConsumer('consumer-high', 'consumer_left');
    expect(leave?.unneededLayers).toEqual([{ spatialLayer: 2, temporalLayer: undefined }]);

    const audio = createProducer('audio');
    const audioState = new ProducerDynacastDemandState(audio);
    audioState.setAvailableLayers([{ spatialLayer: 0, active: true }], 'initial');
    expect(audioState.snapshot().enabled).toBe(false);
  });

  it('tracks active and suspended layer durations across demand changes', () => {
    let now = 1000;
    const producer = createProducer();
    const state = new ProducerDynacastDemandState(producer, { now: () => now });
    state.setAvailableLayers(availableLayers(), 'initial');

    now = 1600;
    let snapshot = state.snapshot();
    expect(snapshot.suspendedLayerDurationMs).toBe(1800);
    expect(snapshot.layers.find((layer) => layer.layer.spatialLayer === 2)?.suspendedDurationMs).toBe(600);

    now = 2200;
    state.updateConsumer(createConsumer('consumer-high', { spatialLayer: 2 }), 'consumer_joined');
    snapshot = state.snapshot();
    const high = snapshot.layers.find((layer) => layer.layer.spatialLayer === 2);
    expect(high?.activeDurationMs).toBe(0);
    expect(high?.suspendedDurationMs).toBe(1200);
    expect(snapshot.estimatedIngressBandwidthSavedBps).toBe(snapshot.estimatedBandwidthSavedBps);

    now = 2700;
    snapshot = state.snapshot();
    expect(snapshot.layers.find((layer) => layer.layer.spatialLayer === 2)?.activeDurationMs).toBe(500);
  });
});

function createProducer(kind: Producer['kind'] = 'video'): Producer {
  return {
    id: `producer-${kind}`,
    participantId: 'publisher',
    roomId: 'room-1',
    kind,
    transportId: 'transport-pub',
    rtpParameters: {
      codecs: [{ mimeType: kind === 'audio' ? 'audio/opus' : 'video/VP8', payloadType: kind === 'audio' ? 111 : 96, clockRate: kind === 'audio' ? 48000 : 90000 }],
      encodings:
        kind === 'audio'
          ? [{ ssrc: 1000 }]
          : [
              { rid: 'low', ssrc: 1111, spatialLayer: 0, maxBitrate: 250_000 },
              { rid: 'medium', ssrc: 2222, spatialLayer: 1, maxBitrate: 900_000 },
              { rid: 'high', ssrc: 3333, spatialLayer: 2, maxBitrate: 2_500_000 }
            ],
      rtcp: { cname: 'producer', reducedSize: true }
    },
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function createConsumer(id: string, preferredLayers: Consumer['preferredLayers']): Consumer {
  return {
    id,
    producerId: 'producer-video',
    participantId: id.replace('consumer', 'viewer'),
    roomId: 'room-1',
    transportId: `transport-${id}`,
    preferredLayers,
    targetLayers: preferredLayers,
    rtpParameters: {
      codecs: [{ mimeType: 'video/VP8', payloadType: 120, clockRate: 90000 }],
      encodings: [{ ssrc: 9000 }],
      rtcp: { cname: id, reducedSize: true }
    },
    status: 'live',
    createdAt: new Date().toISOString()
  };
}

function availableLayers(): RtpLayerInfo[] {
  return [
    { rid: 'low', spatialLayer: 0, ssrc: 1111, maxBitrate: 250_000, active: true },
    { rid: 'medium', spatialLayer: 1, ssrc: 2222, maxBitrate: 900_000, active: true },
    { rid: 'high', spatialLayer: 2, ssrc: 3333, maxBitrate: 2_500_000, active: true }
  ];
}
