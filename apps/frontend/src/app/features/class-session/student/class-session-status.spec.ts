import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute } from '@angular/router';
import { AuthService } from '../../../core/services/auth.service';
import { RoomStore } from '../../../core/services/room.store';
import { SocketService } from '../../../core/services/socket.service';
import { WebRtcService } from '../../../core/services/webrtc.service';
import { ClassSessionService } from '../class-session.service';
import { StudentClassSession } from './class-session';

describe('Student classroom stage join status', () => {
  it('invalidates an already-read prejoin status after join and again after leaving', async () => {
    const room = { id: 'room', participants: [{ id: 'teacher', userId: 'teacher-user', role: 'HOST', connected: true }], producers: [{ id: 'camera', roomId: 'room', participantId: 'teacher', kind: 'video', status: 'live', createdAt: '2026-10-27T00:00:00.000Z' }] };
    const store = { room: signal<any>(null), localParticipantId: signal<string | null>(null), setRoom: (value: any) => store.room.set(value), setLocalParticipant: (value: string) => store.localParticipantId.set(value) };
    const socket = { emitAck: jasmine.createSpy('emitAck').and.resolveTo({ room, participantId: 'student' }) };
    const webrtc = { lastMediaError: signal(null), localStream: signal(null), remoteStreams: signal([{ producerId: 'camera', stream: new MediaStream() }]) };
    TestBed.configureTestingModule({ providers: [
      { provide: ActivatedRoute, useValue: {} }, { provide: AuthService, useValue: { user: signal({ id: 'student-user', name: 'Student' }) } },
      { provide: ClassSessionService, useValue: {} }, { provide: SocketService, useValue: socket }, { provide: RoomStore, useValue: store }, { provide: WebRtcService, useValue: webrtc }
    ] });
    const component: any = TestBed.runInInjectionContext(() => new StudentClassSession());
    const payload = { status: 'live', roomId: 'room', teacherId: 'teacher-user', participants: [] };
    component.session.set(payload);
    for (const method of ['loadLiveWhiteboardMemory', 'syncTeacherModerationFromLocalParticipant', 'syncLocalParticipantMediaState', 'startActivityHeartbeat', 'stopActivityHeartbeat', 'cleanupLocalMediaLocally']) spyOn(component, method).and.stub();
    for (const method of ['consumeAvailableTeacherProducers', 'publishEnabledStudentMedia', 'closeStudentProducers']) spyOn(component, method).and.resolveTo();
    expect(component.stageStatusText()).toBe('Join to watch teacher media.');
    await component.joinClassroomRoom(payload);
    expect(socket.emitAck).toHaveBeenCalledWith('room:join', jasmine.objectContaining({ roomId: 'room' }));
    expect(component.roomJoined()).toBeTrue();
    expect(component.stageStatusText()).toBe('Camera live');
    await component.leaveCurrentRoom();
    expect(component.roomJoined()).toBeFalse();
    expect(component.stageStatusText()).toBe('Join to watch teacher media.');
  });
});
