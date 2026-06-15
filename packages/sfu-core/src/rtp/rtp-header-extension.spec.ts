import type { RtpParameters } from '@native-sfu/contracts';
import {
  RTP_HEADER_EXTENSION_URIS,
  parseRtpHeaderExtensions,
  rewriteRtpHeaderExtensions,
  serializeRtpHeaderExtensionElements,
  negotiateRtpHeaderExtensions
} from './rtp-header-extension';
import { RtpPacket } from './rtp-packet';

describe('RTP header extension framework', () => {
  it('parses negotiated one-byte header extensions', () => {
    const packet = new RtpPacket(2, false, true, false, 96, 1, 1000, 1111, [], serializeRtpHeaderExtensionElements([
      { id: 1, data: Buffer.from('0') },
      { id: 2, data: Buffer.from('high') },
      { id: 3, data: Buffer.from([0x85]) },
      { id: 4, data: Buffer.from([0x12, 0x34]) }
    ]), Buffer.from('payload'));

    const parsed = parseRtpHeaderExtensions(packet, {
      headerExtensions: [
        { id: 1, uri: RTP_HEADER_EXTENSION_URIS.mid },
        { id: 2, uri: RTP_HEADER_EXTENSION_URIS.rid },
        { id: 3, uri: RTP_HEADER_EXTENSION_URIS.audioLevel },
        { id: 4, uri: RTP_HEADER_EXTENSION_URIS.twcc }
      ]
    });

    expect(parsed.map((extension) => [extension.kind, extension.value])).toEqual([
      ['mid', '0'],
      ['rid', 'high'],
      ['audioLevel', { voiceActivity: true, level: 5 }],
      ['twcc', 0x1234]
    ]);
  });

  it('rewrites extension IDs per consumer and inserts outbound TWCC', () => {
    const source = rtpParameters([
      { id: 1, uri: RTP_HEADER_EXTENSION_URIS.mid },
      { id: 2, uri: RTP_HEADER_EXTENSION_URIS.rid },
      { id: 3, uri: RTP_HEADER_EXTENSION_URIS.audioLevel }
    ]);
    const target = rtpParameters([
      { id: 8, uri: RTP_HEADER_EXTENSION_URIS.mid },
      { id: 9, uri: RTP_HEADER_EXTENSION_URIS.rid },
      { id: 10, uri: RTP_HEADER_EXTENSION_URIS.audioLevel },
      { id: 5, uri: RTP_HEADER_EXTENSION_URIS.twcc },
      { id: 6, uri: RTP_HEADER_EXTENSION_URIS.absoluteSendTime }
    ]);
    const packet = new RtpPacket(2, false, true, false, 96, 10, 1000, 1111, [], serializeRtpHeaderExtensionElements([
      { id: 1, data: Buffer.from('video') },
      { id: 2, data: Buffer.from('high') },
      { id: 3, data: Buffer.from([0x01]) }
    ]), Buffer.from('payload'));

    const rewritten = new RtpPacket(
      packet.version,
      packet.padding,
      true,
      packet.marker,
      packet.payloadType,
      packet.sequenceNumber,
      packet.timestamp,
      packet.ssrc,
      packet.csrc,
      rewriteRtpHeaderExtensions(packet, negotiateRtpHeaderExtensions(source, target), {
        twccSequenceNumber: 77,
        absoluteSendTime: 0x010203
      }),
      packet.payload
    );

    const parsed = parseRtpHeaderExtensions(rewritten, target);
    expect(parsed.map((extension) => [extension.id, extension.kind, extension.value])).toEqual([
      [5, 'twcc', 77],
      [6, 'absoluteSendTime', 0x010203],
      [8, 'mid', 'video'],
      [9, 'rid', 'high'],
      [10, 'audioLevel', { voiceActivity: false, level: 1 }]
    ]);
  });
});

function rtpParameters(headerExtensions: NonNullable<RtpParameters['headerExtensions']>): RtpParameters {
  return {
    codecs: [{ mimeType: 'video/VP8', payloadType: 96, clockRate: 90000 }],
    headerExtensions,
    encodings: [{ ssrc: 1111 }],
    rtcp: { cname: 'test', reducedSize: true }
  };
}
