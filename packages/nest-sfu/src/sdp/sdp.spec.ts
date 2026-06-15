import { buildUnifiedPlanAnswer, parseSdpCandidates, parseSdpDtlsParameters, parseSdpIceParameters, parseSdpRtpParameters } from './sdp';
import type { TransportOptions } from '@native-sfu/contracts';

describe('SDP helpers', () => {
  it('parses Chrome Unified Plan video offers with RTX/FID groups', () => {
    const rtp = parseSdpRtpParameters('video', chromeVideoOffer());

    expect(rtp.codecs[0]?.mimeType).toBe('video/VP8');
    expect(rtp.codecs[0]?.payloadType).toBe(96);
    expect(rtp.codecs[1]?.mimeType).toBe('video/rtx');
    expect(rtp.codecs[1]?.payloadType).toBe(97);
    expect(rtp.codecs[1]?.parameters?.apt).toBe(96);
    expect(rtp.encodings.map((encoding) => encoding.ssrc)).toEqual([11111111]);
    expect(rtp.encodings[0]?.rtx).toEqual({ ssrc: 11111112, payloadType: 97 });
    expect(rtp.rtcp.cname).toBe('chrome-cname');
    expect(rtp.headerExtensions?.map((extension) => [extension.id, extension.uri])).toEqual([
      [1, 'urn:ietf:params:rtp-hdrext:sdes:mid'],
      [2, 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id'],
      [3, 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01'],
      [4, 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time']
    ]);
    expect(parseSdpCandidates(chromeVideoOffer())[0]?.type).toBe('host');
  });

  it('parses Firefox audio offers with session-level ICE and fingerprint lines', () => {
    const offer = firefoxAudioOffer();
    const ice = parseSdpIceParameters(offer, 'audio');
    const dtls = parseSdpDtlsParameters(offer, 'audio');
    const rtp = parseSdpRtpParameters('audio', offer);

    expect(ice.usernameFragment).toBe('firefoxUfrag');
    expect(dtls.fingerprints[0]?.algorithm).toBe('sha-256');
    expect(rtp.codecs[0]?.mimeType).toBe('audio/opus');
    expect(rtp.encodings[0]?.ssrc).toBe(22222222);
  });

  it('parses Safari H264 video offers and builds a Unified Plan answer', () => {
    const offer = safariVideoOffer();
    const rtp = parseSdpRtpParameters('video', offer);
    const answer = buildUnifiedPlanAnswer({ transport: transportFixture(), offer, direction: 'sendonly', rtpParameters: rtp });

    expect(rtp.codecs[0]?.mimeType).toBe('video/H264');
    expect(rtp.codecs[0]?.payloadType).toBe(102);
    expect(answer).toContain('a=mid:0');
    expect(answer).toContain('a=setup:passive');
    expect(answer).toContain('a=sendonly');
    expect(answer).toContain('a=rtcp-mux');
    expect(answer).toContain('a=ssrc:33333333 cname:safari-cname');
  });

  it('answers the selected Unified Plan media section and rejects unrelated sections', () => {
    const offer = chromeAudioVideoOffer();
    const rtp = parseSdpRtpParameters('video', offer);
    const answer = buildUnifiedPlanAnswer({ transport: transportFixture(), offer, direction: 'sendonly', mediaKind: 'video', rtpParameters: rtp });

    expect(answer).toContain('a=group:BUNDLE 1');
    expect(answer).toContain('m=audio 0 UDP/TLS/RTP/SAVPF 111');
    expect(answer).toContain('a=mid:0');
    expect(answer).toContain('a=inactive');
    expect(answer).toContain('m=video 9 UDP/TLS/RTP/SAVPF 96 97');
    expect(answer).toContain('a=mid:1');
    expect(answer).toContain('a=sendonly');
    expect(answer).toContain('a=ssrc:11111111 cname:chrome-cname');
  });

  it('parses RID simulcast offers without SSRCs and generates recv RID answers', () => {
    const offer = chromeSimulcastOffer();
    const rtp = parseSdpRtpParameters('video', offer);
    const answer = buildUnifiedPlanAnswer({ transport: transportFixture(), offer, direction: 'recvonly', mediaKind: 'video', rtpParameters: rtp });

    expect(rtp.encodings.map((encoding) => [encoding.rid, encoding.ssrc, encoding.spatialLayer, encoding.maxBitrate])).toEqual([
      ['low', undefined, 0, 250000],
      ['medium', undefined, 1, 900000],
      ['high', undefined, 2, 2500000]
    ]);
    expect(rtp.simulcast).toEqual({ direction: 'send', rids: ['low', 'medium', 'high'], pausedRids: [] });
    expect(answer).toContain('a=rid:low recv');
    expect(answer).toContain('a=rid:medium recv');
    expect(answer).toContain('a=rid:high recv');
    expect(answer).toContain('a=simulcast:recv low;medium;high');
  });
});

function transportFixture(): TransportOptions {
  return {
    id: 'transport-1',
    roomId: 'room-1',
    participantId: 'participant-1',
    iceParameters: { usernameFragment: 'localUfrag', password: 'localPassword', iceLite: false },
    iceCandidates: [
      {
        foundation: '1',
        component: 1,
        protocol: 'udp',
        priority: 2130706431,
        ip: '127.0.0.1',
        port: 40000,
        type: 'host'
      }
    ],
    dtlsParameters: {
      role: 'auto',
      fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB:CC' }]
    }
  };
}

function chromeVideoOffer(): string {
  return [
    'v=0',
    'o=- 1 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS stream',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=ice-ufrag:chromeUfrag',
    'a=ice-pwd:chromePassword',
    'a=fingerprint:sha-256 11:22:33',
    'a=setup:actpass',
    'a=sendonly',
    'a=rtcp-mux',
    'a=rtcp-rsize',
    'a=extmap-allow-mixed',
    'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid',
    'a=extmap:2 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id',
    'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
    'a=extmap:4 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
    'a=rtpmap:96 VP8/90000',
    'a=rtcp-fb:96 nack',
    'a=rtcp-fb:96 nack pli',
    'a=rtpmap:97 rtx/90000',
    'a=fmtp:97 apt=96',
    'a=ssrc-group:FID 11111111 11111112',
    'a=ssrc:11111111 cname:chrome-cname',
    'a=ssrc:11111112 cname:chrome-cname',
    'a=candidate:1 1 UDP 2130706431 127.0.0.1 50000 typ host',
    ''
  ].join('\r\n');
}

function chromeSimulcastOffer(): string {
  return [
    'v=0',
    'o=- 5 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS stream',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=ice-ufrag:chromeUfrag',
    'a=ice-pwd:chromePassword',
    'a=fingerprint:sha-256 11:22:33',
    'a=setup:actpass',
    'a=sendonly',
    'a=rtcp-mux',
    'a=rtcp-rsize',
    'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid',
    'a=extmap:2 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id',
    'a=extmap:3 urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id',
    'a=rtpmap:96 VP8/90000',
    'a=rtcp-fb:96 nack pli',
    'a=rtpmap:97 rtx/90000',
    'a=fmtp:97 apt=96',
    'a=rid:low send max-br=250000;max-width=480',
    'a=rid:medium send max-br=900000;max-width=960',
    'a=rid:high send max-br=2500000;max-width=1920',
    'a=simulcast:send low;medium;high',
    'a=candidate:1 1 udp 2130706431 127.0.0.1 40000 typ host',
    'a=end-of-candidates',
    ''
  ].join('\r\n');
}

function firefoxAudioOffer(): string {
  return [
    'v=0',
    'o=mozilla...THIS_IS_SDPARTA-99.0 1 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    'a=ice-ufrag:firefoxUfrag',
    'a=ice-pwd:firefoxPassword',
    'a=fingerprint:sha-256 44:55:66',
    'a=group:BUNDLE 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 109',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=sendonly',
    'a=setup:actpass',
    'a=rtcp-mux',
    'a=rtpmap:109 opus/48000/2',
    'a=ssrc:22222222 cname:firefox-cname',
    'a=candidate:2 1 UDP 2122252543 127.0.0.1 50001 typ host',
    ''
  ].join('\r\n');
}

function safariVideoOffer(): string {
  return [
    'v=0',
    'o=- 3 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 102',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=ice-ufrag:safariUfrag',
    'a=ice-pwd:safariPassword',
    'a=fingerprint:sha-256 77:88:99',
    'a=setup:actpass',
    'a=sendonly',
    'a=rtcp-mux',
    'a=rtcp-rsize',
    'a=rtpmap:102 H264/90000',
    'a=fmtp:102 packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1',
    'a=rtcp-fb:102 nack pli',
    'a=ssrc:33333333 cname:safari-cname',
    'a=candidate:3 1 UDP 2122260223 127.0.0.1 50002 typ host',
    ''
  ].join('\r\n');
}

function chromeAudioVideoOffer(): string {
  return [
    'v=0',
    'o=- 4 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'a=msid-semantic: WMS stream',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=ice-ufrag:chromeUfrag',
    'a=ice-pwd:chromePassword',
    'a=fingerprint:sha-256 11:22:33',
    'a=setup:actpass',
    'a=sendonly',
    'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2',
    'a=ssrc:44444444 cname:chrome-audio-cname',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    'a=ice-ufrag:chromeUfrag',
    'a=ice-pwd:chromePassword',
    'a=fingerprint:sha-256 11:22:33',
    'a=setup:actpass',
    'a=sendonly',
    'a=rtcp-mux',
    'a=rtcp-rsize',
    'a=rtpmap:96 VP8/90000',
    'a=rtcp-fb:96 nack',
    'a=rtcp-fb:96 nack pli',
    'a=rtpmap:97 rtx/90000',
    'a=fmtp:97 apt=96',
    'a=ssrc-group:FID 11111111 11111112',
    'a=ssrc:11111111 cname:chrome-cname',
    'a=ssrc:11111112 cname:chrome-cname',
    'a=candidate:4 1 UDP 2130706431 127.0.0.1 50003 typ host',
    ''
  ].join('\r\n');
}
