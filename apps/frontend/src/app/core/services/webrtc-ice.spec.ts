import { of } from 'rxjs';
import { WebRtcService } from './webrtc.service';

describe('Classroom ICE candidate signaling', () => {
  it('sends UDP candidates and ignores unsupported Chromium TCP candidates', async () => {
    const emitAck = jasmine.createSpy('emitAck').and.resolveTo(undefined);
    const service = new WebRtcService({ emitAck } as any, { get: () => of({ uris: [] }) } as any);
    const peer: RTCPeerConnection = await (service as any).createPeer({ id: 'transport', iceCandidates: [{ protocol: 'udp' }] });
    try {
      for (const candidate of [
        'candidate:1 1 udp 2122260223 127.0.0.1 40000 typ host',
        'candidate:2 1 tcp 1518280447 127.0.0.1 9 typ host tcptype active'
      ]) peer.onicecandidate!.call(peer, { candidate: { candidate } } as RTCPeerConnectionIceEvent);
      expect(emitAck).toHaveBeenCalledTimes(1);
      expect(emitAck.calls.first().args[1].candidate.protocol).toBe('udp');
    } finally { peer.close(); }
  });

  it('reads TURN credentials from the real API success envelope', async () => {
    const credentials = { uris: ['turn:127.0.0.1:3478?transport=udp'], username: 'acceptance', credential: 'local-test-token', ttl: 3600 };
    const service = new WebRtcService({ emitAck: jasmine.createSpy('emitAck') } as any, { get: () => of({ data: credentials }) } as any);
    const peer: RTCPeerConnection = await (service as any).createPeer({ id: 'transport', iceCandidates: [{ protocol: 'udp' }] });
    try {
      expect(service.turnStatus().state).toBe('ready');
      expect(peer.getConfiguration().iceServers?.[0]?.urls).toEqual(credentials.uris);
      expect(peer.getConfiguration().iceServers?.[0]?.username).toBe('acceptance');
    } finally { peer.close(); }
  });

  it('handles a rejected trickle ACK without an unhandled promise rejection', async () => {
    const error = new Error('Connection closed while gathering ICE');
    const emitAck = jasmine.createSpy('emitAck').and.rejectWith(error);
    const warning = spyOn(console, 'warn');
    const service = new WebRtcService({ emitAck } as any, { get: () => of({ uris: [] }) } as any);
    const peer: RTCPeerConnection = await (service as any).createPeer({ id: 'transport', iceCandidates: [{ protocol: 'udp' }] });
    try {
      peer.onicecandidate!.call(peer, { candidate: { candidate: 'candidate:1 1 udp 2122260223 127.0.0.1 40000 typ host' } } as RTCPeerConnectionIceEvent);
      await Promise.resolve();
      expect(warning).toHaveBeenCalledWith('[WebRtcService] Could not send ICE candidate.', error);
    } finally { peer.close(); }
  });
});
