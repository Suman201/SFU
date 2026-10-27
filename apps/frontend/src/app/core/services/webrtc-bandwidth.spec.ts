import { HttpClient } from '@angular/common/http';
import { SocketService } from './socket.service';
import { WebRtcService } from './webrtc.service';

describe('Classroom weak-connection mode', () => {
  let service: WebRtcService;
  let socket: jasmine.SpyObj<SocketService>;
  beforeEach(() => {
    socket = jasmine.createSpyObj('SocketService', ['emitAck']); socket.emitAck.and.resolveTo(undefined);
    service = new WebRtcService(socket, {} as HttpClient);
    const kinds = ['audio', 'video', 'screen'] as const;
    (service as any).remoteConsumers = new Map(kinds.map((kind) => [kind, { consumer: { id: `consumer-${kind}`, producerId: kind } }]));
    service.remoteStreams.set(kinds.map((kind) => ({ producerId: kind, participantId: kind, consumerId: `consumer-${kind}`, kind, stream: new MediaStream() })));
  });
  it('pauses participant cameras while retaining voice and shared lesson content', async () => {
    await service.setLowBandwidth(true);
    expect(socket.emitAck.calls.allArgs()).toEqual([['consumer:pause', { consumerId: 'consumer-video' }]]);
    expect(service.lowBandwidth()).toBeTrue();
  });
  it('restores only cameras paused by this mode', async () => {
    await service.setLowBandwidth(true); socket.emitAck.calls.reset();
    await service.setLowBandwidth(false);
    expect(socket.emitAck.calls.allArgs()).toEqual([['consumer:resume', { consumerId: 'consumer-video' }]]);
    expect(service.lowBandwidth()).toBeFalse();
  });
  it('does not resume unrelated moderator-paused cameras', async () => {
    await service.setLowBandwidth(false);
    expect(socket.emitAck).not.toHaveBeenCalled();
  });
});
