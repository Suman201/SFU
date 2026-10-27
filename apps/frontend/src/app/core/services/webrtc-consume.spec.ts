import { of } from 'rxjs';
import { WebRtcService } from './webrtc.service';

describe('Native browser receive SDP', () => {
  for (const kind of ['video', 'screen'] as const) {
    it(`accepts one ${kind} track with primary and retransmission SSRCs`, async () => {
      const peer = new RTCPeerConnection({ iceServers: [] });
      const transport = {
        id: `receive-${kind}`,
        iceParameters: { usernameFragment: 'test', password: 'local-browser-test-password-12345' },
        iceCandidates: [{ foundation: '1', component: 1, priority: 2130706431, ip: '127.0.0.1', protocol: 'udp', port: 9, type: 'host' }],
        dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: Array(32).fill('AB').join(':') }] }
      };
      const emitAck = jasmine.createSpy('emitAck').and.callFake(async (event: string) => {
        if (event !== 'consumer:create') return undefined;
        const offer = peer.localDescription!.sdp;
        const primary = Number(offer.match(/a=rtpmap:(\d+) VP8\/90000/i)![1]);
        const rtx = Number(offer.match(new RegExp(`a=fmtp:(\\d+) apt=${primary}(?:\\r|\\n|$)`))![1]);
        return {
          id: `consumer-${kind}`, producerId: `producer-${kind}`, kind,
          rtpParameters: {
            codecs: [{ payloadType: primary }, { payloadType: rtx }],
            encodings: [{ ssrc: 111111, rtx: { ssrc: 222222 } }],
            rtcp: { cname: 'browser-regression' }
          }
        };
      });
      const service = new WebRtcService({ emitAck } as any, { get: () => of({ uris: [] }) } as any);
      (service as any).peers.set(transport.id, peer);
      spyOn(service as any, 'preparePeer').and.resolveTo(transport);
      try {
        const consumer = await service.consumeProducer('room', { id: `producer-${kind}`, participantId: 'teacher', kind, ...(kind === 'screen' ? { source: 'screen' } : {}), status: 'live' } as any);
        expect(consumer?.id).toBe(`consumer-${kind}`);
        expect(peer.signalingState).toBe('stable');
        expect(peer.getReceivers().filter((receiver) => receiver.track.kind === 'video').length).toBe(1);
        expect(service.remoteStreams().length).toBe(1);
        expect(service.remoteStreams()[0]!.stream.getVideoTracks().length).toBe(1);
        expect(service.remoteStreams()[0]!.source).toBe(kind === 'screen' ? 'screen' : undefined);
        expect(service.lastMediaError()).toBeNull();
      } finally {
        peer.close();
      }
    });
  }
});
