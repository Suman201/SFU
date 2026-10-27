import { HttpClient } from '@angular/common/http';
import { SocketService } from './socket.service';
import { WebRtcService } from './webrtc.service';

describe('Device whiteboard capture lifecycle', () => {
  let service: WebRtcService;
  let request: jasmine.Spy;
  const streams: MediaStream[] = [];
  const canvasStream = () => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 16;
    const stream = canvas.captureStream(1); streams.push(stream); return stream;
  };
  beforeEach(() => {
    service = new WebRtcService({ emitAck: jasmine.createSpy().and.resolveTo(undefined) } as unknown as SocketService, {} as HttpClient);
    request = spyOn(navigator.mediaDevices, 'getDisplayMedia');
  });
  afterEach(() => { streams.splice(0).forEach(stream => stream.getTracks().forEach(track => track.stop())); });

  it('keeps the existing classroom source live until the selected device capture is committed', async () => {
    const current = canvasStream(); const candidate = canvasStream();
    service.screenStream.set(current); request.and.resolveTo(candidate);
    expect(await service.captureScreen()).toBe(candidate);
    expect(service.screenStream()).toBe(current);
    expect(current.getVideoTracks()[0]!.readyState).toBe('live');
  });

  it('preserves the classroom source when the user cancels the picker', async () => {
    const current = canvasStream(); service.screenStream.set(current);
    request.and.rejectWith(new DOMException('Cancelled', 'NotAllowedError'));
    await expectAsync(service.captureScreen()).toBeRejected();
    expect(service.screenStream()).toBe(current); expect(current.getVideoTracks()[0]!.readyState).toBe('live');
  });

  it('rejects a source that ended before the picker completed without replacing the current board', async () => {
    const current = canvasStream(); const ended = canvasStream(); ended.getTracks().forEach(track => track.stop());
    service.screenStream.set(current); request.and.resolveTo(ended);
    await expectAsync(service.captureScreen()).toBeRejectedWithError(/stopped sharing/);
    expect(service.screenStream()).toBe(current);
  });

  it('retains startScreen compatibility for callers that activate immediately', async () => {
    const candidate = canvasStream(); request.and.resolveTo(candidate);
    await service.startScreen(); expect(service.screenStream()).toBe(candidate);
  });

  it('releases revoked sender tracks and peer connections without contacting the server or stopping the camera', () => {
    const screen = canvasStream(); const camera = canvasStream(); service.localStream.set(camera);
    const peer = { close: jasmine.createSpy() };
    (service as any).peers.set('share-transport', peer);
    (service as any).transportPublishCounts.set('share-transport', 1);
    (service as any).publishedProducers.set('share', { kind: 'screen', transportId: 'share-transport', senders: [{ sender: { track: screen.getVideoTracks()[0] } }] });
    service.releaseLocalProducer('share'); service.releaseLocalProducer('share');
    expect(screen.getVideoTracks()[0]!.readyState).toBe('ended'); expect(camera.getVideoTracks()[0]!.readyState).toBe('live');
    expect(peer.close).toHaveBeenCalledOnceWith(); expect((service as any).peers.has('share-transport')).toBeFalse();
    expect((service as any).publishedProducers.has('share')).toBeFalse();
    expect((service as any).socket.emitAck).not.toHaveBeenCalled();
  });
  it('closes a failed replacement peer while preserving the existing source and camera', async () => {
    const current = canvasStream(); const candidate = canvasStream(); const camera = canvasStream();
    service.screenStream.set(current); service.localStream.set(camera);
    const oldPeer = new RTCPeerConnection({ iceServers: [] });
    const replacementPeer = new RTCPeerConnection({ iceServers: [] });
    (service as any).peers.set('old-transport', oldPeer);
    (service as any).transportPublishCounts.set('old-transport', 1);
    (service as any).peers.set('replacement-transport', replacementPeer);
    spyOn(service, 'preparePeer').and.resolveTo({ id: 'replacement-transport' } as any);
    spyOn(replacementPeer, 'createOffer').and.rejectWith(new Error('Negotiation failed'));
    try {
      await expectAsync(service.publish('room', { id: 'old-transport' } as any, 'screen', candidate)).toBeRejectedWithError('Negotiation failed');
      expect(replacementPeer.signalingState).toBe('closed');
      expect((service as any).peers.has('replacement-transport')).toBeFalse();
      expect(oldPeer.signalingState).toBe('stable');
      expect(service.screenStream()).toBe(current);
      expect(current.getVideoTracks()[0]!.readyState).toBe('live');
      expect(camera.getVideoTracks()[0]!.readyState).toBe('live');
    } finally { oldPeer.close(); replacementPeer.close(); }
  });

});
