import type { RtpParameters } from '@native-sfu/contracts';
import { RtpPacket } from '../rtp/rtp-packet';
import { detectSvcCapabilities, detectSvcLayer, parseScalabilityMode, parseVp9PayloadDescriptor } from './svc-layer-detector';

describe('SVC layer detector', () => {
  it('parses VP9 SID/TID and flexible-mode references from the payload descriptor', () => {
    const descriptor = parseVp9PayloadDescriptor(Buffer.from([0x70, 0x64, 0x82, 0x01, 0x10]));

    expect(descriptor?.temporalLayerId).toBe(3);
    expect(descriptor?.spatialLayerId).toBe(2);
    expect(descriptor?.interLayerDependency).toBe(false);
    expect(descriptor?.referenceDiffs).toEqual([2, 1]);
  });

  it('detects VP9 SVC packet layers', () => {
    const result = detectSvcLayer(packet(Buffer.from([0x28, 0x53, 0x00, 0x10])), 'video/VP9');

    expect(result?.codec).toBe('VP9');
    expect(result?.layer).toEqual({ spatialLayerId: 1, temporalLayerId: 2, qualityLayerId: 1 });
    expect(result?.requiresKeyframe).toBe(true);
  });

  it('detects VP8 temporal-only fallback and H264 single-layer fallback', () => {
    const vp8 = detectSvcLayer(packet(Buffer.from([0x90, 0x20, 0x80, 0x10])), 'video/VP8');
    expect(vp8?.codec).toBe('VP8');
    expect(vp8?.layer).toEqual({ spatialLayerId: 0, temporalLayerId: 2, qualityLayerId: 0 });
    expect(vp8?.fallback).toBe('vp8_temporal_only');
    const h264 = detectSvcLayer(packet(Buffer.from([0x65, 0x88])), 'video/H264');
    expect(h264?.codec).toBe('H264');
    expect(h264?.layer).toEqual({ spatialLayerId: 0, temporalLayerId: 0, qualityLayerId: 0 });
    expect(h264?.fallback).toBe('h264_single_layer');
  });

  it('derives SVC capabilities from scalabilityMode', () => {
    const parameters: RtpParameters = {
      codecs: [{ mimeType: 'video/VP9', payloadType: 98, clockRate: 90000, parameters: { 'scalability-mode': 'L3T2_KEY' } }],
      encodings: [{ ssrc: 7777, scalabilityMode: 'L3T2_KEY' }],
      rtcp: { cname: 'producer', reducedSize: true }
    };

    expect(parseScalabilityMode('L3T2_KEY')).toEqual({ scalabilityMode: 'L3T2_KEY', spatialLayerCount: 3, temporalLayerCount: 2 });
    const capabilities = detectSvcCapabilities(parameters);
    expect(capabilities.supported).toBe(true);
    expect(capabilities.codec).toBe('VP9');
    expect(capabilities.scalabilityMode).toBe('L3T2_KEY');
    expect(capabilities.spatialLayerCount).toBe(3);
    expect(capabilities.temporalLayerCount).toBe(2);
    expect(capabilities.fallback).toBe('native_svc');
  });
});

function packet(payload: Buffer): RtpPacket {
  return new RtpPacket(2, false, false, false, 98, 1, 1000, 7777, [], null, payload);
}
