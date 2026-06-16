import type { Producer } from '@native-sfu/contracts';
import { ProducerSimulcastState, preferredLayerNameToSelection } from './simulcast-state';

describe('ProducerSimulcastState', () => {
  it('tracks available/current layers and picks layers from preferences and bitrate', () => {
    const producer = createProducer();
    const state = new ProducerSimulcastState(producer, () => 1000);

    expect(state.availableLayers().map((layer) => [layer.rid, layer.spatialLayer, layer.active])).toEqual([
      ['low', 0, false],
      ['medium', 1, false],
      ['high', 2, false]
    ]);

    state.markPacket(1111);
    state.markPacket(3333);

    expect(state.currentLayers()).toEqual({ spatialLayer: 2, temporalLayer: undefined });
    expect(producer.availableLayers?.filter((layer) => layer.active).map((layer) => layer.rid)).toEqual(['low', 'high']);
    expect(
      state.selectLayer(
        {
          id: 'consumer-1',
          estimatedIncomingBitrate: 0,
          estimatedOutgoingBitrate: 0,
          availableBitrate: 350_000,
          recommendedBitrate: 300_000,
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
        },
        preferredLayerNameToSelection('high')
      ).selection
    ).toEqual({ spatialLayer: 0, temporalLayer: undefined });
  });

  it('binds RID-only browser SSRCs when packets arrive', () => {
    const producer = createProducer(null);
    const state = new ProducerSimulcastState(producer);

    expect(state.knownMediaSsrcs()).toEqual([]);
    expect(state.bindMediaSsrc('medium', 4444)?.encoding.ssrc).toBe(4444);
    expect(state.knownMediaSsrcs()).toEqual([4444]);
    expect(state.layerSelectionForSsrc(4444)).toEqual({ spatialLayer: 1, temporalLayer: undefined });
  });
});

function createProducer(firstSsrc: number | null = 1111): Producer {
  return {
    id: 'producer-1',
    participantId: 'publisher',
    roomId: 'room-1',
    kind: 'video',
    transportId: 'transport-pub',
    status: 'live',
    createdAt: new Date().toISOString(),
    rtpParameters: {
      codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 }],
      encodings: [
        { rid: 'low', ssrc: firstSsrc ?? undefined, spatialLayer: 0, maxBitrate: 250_000 },
        { rid: 'medium', ssrc: firstSsrc === null ? undefined : 2222, spatialLayer: 1, maxBitrate: 900_000 },
        { rid: 'high', ssrc: firstSsrc === null ? undefined : 3333, spatialLayer: 2, maxBitrate: 2_500_000 }
      ],
      rtcp: { cname: 'producer', reducedSize: true }
    }
  };
}
