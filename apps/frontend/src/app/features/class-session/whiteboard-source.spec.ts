import { ElementRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { LessonRecordingService } from '../../core/services/lesson-recording.service';
import { RoomStore } from '../../core/services/room.store';
import { SocketService } from '../../core/services/socket.service';
import { WebRtcService } from '../../core/services/webrtc.service';
import { WhiteboardSourceControl } from '../../shared/whiteboard-source/whiteboard-source';
import { ClassSessionService } from './class-session.service';
import { StudentClassSession } from './student/class-session';
import { TeacherClassSession } from './teacher/class-session';

// Deterministic local state checks: no device picker, media server, or visible app is started.
describe('Classroom whiteboard source lifecycle', () => {
  const streams: MediaStream[] = [];
  function stream(): MediaStream {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    const result = canvas.captureStream(1);
    streams.push(result);
    return result;
  }
  const producer = (id: string, participantId = 'teacher', source = 'screen', kind = 'screen') => ({ id, participantId, roomId: 'room', source, kind, status: 'live', createdAt: '2026-10-27T00:00:00.000Z' });
  function setup(role: 'teacher' | 'student' = 'teacher') {
    const handlers = new Map<string, (...args: any[]) => void>();
    const realtime = { connected: true, on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler), off: jasmine.createSpy(), once: jasmine.createSpy() };
    const socket = { connect: () => realtime, emitAck: jasmine.createSpy('emitAck').and.resolveTo({}) };
    const screenStream = signal<MediaStream | null>(null);
    const webrtc = {
      lastMediaError: signal(null), localStream: signal<MediaStream | null>(null), screenStream,
      remoteStreams: signal<any[]>([]), networkScore: signal(5), devices: signal({ audioInputs: [], videoInputs: [] }),
      captureScreen: jasmine.createSpy('captureScreen').and.callFake(async () => stream()),
      preparePeer: jasmine.createSpy('preparePeer').and.resolveTo({ id: 'transport' }),
      publish: jasmine.createSpy('publish').and.callFake(async (_room: string, _transport: unknown, _kind: string, _stream: MediaStream, options: any) => producer('new-source', role, options.source)),
      closeProducer: jasmine.createSpy('closeProducer').and.resolveTo(), releaseLocalProducer: jasmine.createSpy('releaseLocalProducer'),
      stopScreen: jasmine.createSpy('stopScreen').and.callFake(() => { screenStream()?.getTracks().forEach(track => track.stop()); screenStream.set(null); }),
      removeRemoteProducer: jasmine.createSpy('removeRemoteProducer'), consumeProducer: jasmine.createSpy('consumeProducer').and.resolveTo(null),
      resetRoomMedia: jasmine.createSpy('resetRoomMedia')
    };
    TestBed.configureTestingModule({ providers: [
      RoomStore, { provide: ElementRef, useValue: new ElementRef(document.createElement('div')) },
      { provide: ActivatedRoute, useValue: {} }, { provide: Router, useValue: {} },
      { provide: AuthService, useValue: { user: signal({ id: `${role}-user`, name: role }) } },
      { provide: ClassSessionService, useValue: {} }, { provide: SocketService, useValue: socket },
      { provide: WebRtcService, useValue: webrtc }, { provide: LessonRecordingService, useValue: { activeId: () => '', state: signal('idle') } }
    ] });
    const store = TestBed.inject(RoomStore);
    store.setRoom({ id: 'room', mediaProfile: { id: 'profile' }, consumers: [], producers: [], participants: [
      { id: 'teacher', userId: 'teacher-user', displayName: 'Teacher', role: 'HOST', connected: true, permissions: { canShareScreen: true } },
      { id: 'student', userId: 'student-user', displayName: 'Student', role: 'PARTICIPANT', connected: true, permissions: { canShareScreen: false } },
      { id: 'peer', userId: 'peer-user', displayName: 'Peer', role: 'PARTICIPANT', connected: true, permissions: { canShareScreen: false } }
    ] } as any);
    store.setLocalParticipant(role);
    const target: any = TestBed.runInInjectionContext(() => role === 'teacher' ? new TeacherClassSession() : new StudentClassSession());
    target.session.set({ sessionId: 'session', batchId: 'batch', roomId: 'room', teacherId: 'teacher-user', status: 'live', participants: [] });
    target.joinedRoomId = 'room';
    if (role === 'student') target.whiteboardSocketConnected.set(true);
    if (role === 'teacher') {
      target.roomJoined.set(true);
      target.participants.set([{ id: 'student', canModerate: true }, { id: 'peer', canModerate: true }]);
      target.whiteboard = { captureMediaStream: jasmine.createSpy('captureMediaStream').and.callFake(() => stream()), stopMediaCapture: jasmine.createSpy('stopMediaCapture'), requestCaptureFrame: jasmine.createSpy('requestCaptureFrame') };
    }
    return { target, store, socket, webrtc, handlers };
  }
  function allowStudent(store: RoomStore, allowed = true) {
    store.patchParticipant('student', { permissions: { canShareScreen: allowed } } as any);
  }
  afterEach(() => { for (const value of streams.splice(0)) value.getTracks().forEach(track => track.stop()); });

  it('keeps the existing teacher board and a student presenter when the system picker is cancelled', async () => {
    const { target, store, webrtc, socket } = setup();
    const previous = stream();
    webrtc.screenStream.set(previous); target.whiteboardCaptureStream = previous; target.whiteboardSharing.set(true); target.screenProducerId = 'saved-board';
    store.upsertProducer(producer('saved-board', 'teacher', 'whiteboard') as any);
    store.upsertProducer(producer('student-device', 'student') as any);
    webrtc.captureScreen.and.rejectWith(new DOMException('Cancelled', 'NotAllowedError'));
    await target.shareScreen();
    expect(webrtc.screenStream()).toBe(previous);
    expect(previous.getVideoTracks()[0]!.readyState).toBe('live');
    expect(target.whiteboardSharing()).toBeTrue();
    expect(target.whiteboardSource()).toBe('device');
    expect(socket.emitAck).not.toHaveBeenCalled();
    expect(webrtc.publish).not.toHaveBeenCalled();
    expect(target.whiteboard.stopMediaCapture).not.toHaveBeenCalled();
  });

  it('replaces the teacher source only after a candidate publishes successfully', async () => {
    const { target, store, webrtc } = setup();
    const previous = stream(); const next = stream();
    webrtc.screenStream.set(previous); target.screenProducerId = 'old-device'; store.upsertProducer(producer('old-device') as any);
    webrtc.captureScreen.and.resolveTo(next);
    webrtc.publish.and.callFake(async () => {
      expect(webrtc.screenStream()).toBe(previous);
      expect(previous.getVideoTracks()[0]!.readyState).toBe('live');
      return producer('new-source');
    });
    await target.shareScreen();
    expect(webrtc.screenStream()).toBe(next);
    expect(previous.getVideoTracks()[0]!.readyState).toBe('ended');
    expect(webrtc.releaseLocalProducer).toHaveBeenCalledWith('old-device');
    expect(target.screenProducerId).toBe('new-source');
  });

  it('keeps a previous external stream if publishing its classroom replacement fails before server commit', async () => {
    const { target, store, webrtc } = setup();
    const previous = stream();
    webrtc.screenStream.set(previous); target.screenProducerId = 'old-device'; store.upsertProducer(producer('old-device') as any);
    webrtc.publish.and.rejectWith(new Error('Transport unavailable'));
    await target.useClassroomWhiteboard();
    expect(webrtc.screenStream()).toBe(previous);
    expect(previous.getVideoTracks()[0]!.readyState).toBe('live');
    expect(target.whiteboardSource()).toBe('device');
    expect(target.screenProducerId).toBe('old-device');
  });

  it('clears a server-replaced source if SDP negotiation fails after producer:closed', async () => {
    const { target, store, webrtc, handlers } = setup();
    const previous = stream(); const candidate = stream();
    target.bindSocketEvents();
    webrtc.screenStream.set(previous); target.screenProducerId = 'old-device'; store.upsertProducer(producer('old-device') as any);
    webrtc.captureScreen.and.resolveTo(candidate);
    webrtc.publish.and.callFake(async () => { handlers.get('producer:closed')!('old-device'); throw new Error('SDP negotiation failed'); });
    await target.shareScreen();
    expect(webrtc.screenStream()).toBeNull();
    expect(target.screenProducerId).toBe('');
    expect(previous.getVideoTracks()[0]!.readyState).toBe('ended');
    expect(candidate.getVideoTracks()[0]!.readyState).toBe('ended');
    expect(target.whiteboardSource()).toBe('classroom');
    expect(target.mediaError()).toContain('SDP negotiation failed');
  });

  it('lets the teacher take back the classroom while a student device is the selected source', async () => {
    const { target, store, socket } = setup();
    const board = stream(); target.whiteboardSharing.set(true); target.webrtc.screenStream.set(board); target.screenProducerId = 'saved-board';
    store.upsertProducer(producer('saved-board', 'teacher', 'whiteboard') as any);
    store.upsertProducer(producer('student-device', 'student') as any); allowStudent(store);
    socket.emitAck.and.callFake(async () => { store.removeProducer('student-device'); return {}; });
    expect(target.whiteboardSource()).toBe('device');
    await target.selectWhiteboardSource('classroom');
    expect(socket.emitAck).toHaveBeenCalledWith('permission:update', { roomId: 'room', participantId: 'student', permissions: { canShareScreen: false } });
    expect(target.whiteboardSource()).toBe('classroom');
    expect(target.webrtc.screenStream()).toBe(board);
    expect(target.whiteboard.stopMediaCapture).not.toHaveBeenCalled();
  });

  it('receives device sharing while the presenter camera is hidden locally', async () => {
    const { target, store, webrtc } = setup();
    store.upsertProducer(producer('student-device', 'student') as any);
    store.upsertProducer(producer('student-camera', 'student', undefined, 'video') as any);
    target.locallyHiddenParticipantIds.set(['student']);
    await target.consumeStudentProducer(store.room()!.producers[0]);
    expect(webrtc.consumeProducer).toHaveBeenCalled();
    target.cleanupStudentParticipantMedia('student', true);
    expect(webrtc.removeRemoteProducer).toHaveBeenCalledWith('student-camera');
    expect(webrtc.removeRemoteProducer).not.toHaveBeenCalledWith('student-device');
  });

  it('requests teacher permission without starting capture or publishing', async () => {
    const { target, store, socket, webrtc } = setup('student');
    socket.emitAck.and.resolveTo({ screenShareRequested: true, screenShareRequestedAt: '2026-10-27T00:00:00Z' });
    await target.requestDeviceSharing(); await target.shareDeviceWhiteboard();
    expect(socket.emitAck).toHaveBeenCalledWith('screen:request', { roomId: 'room', requested: true });
    expect(target.deviceShareRequested()).toBeTrue();
    expect(webrtc.captureScreen).not.toHaveBeenCalled();
    allowStudent(store); target.applyLocalParticipantPermissionsPatch('student', { canShareScreen: true });
    expect(webrtc.captureScreen).not.toHaveBeenCalled();
  });

  for (const change of ['permission revoked', 'room disconnected'] as const) {
    it(`discards a pending student picker result when ${change}`, async () => {
      const { target, store, webrtc, handlers } = setup('student'); allowStudent(store);
      target.bindSocketConnectionEvents();
      let resolveCapture!: (value: MediaStream) => void;
      webrtc.captureScreen.and.returnValue(new Promise(resolve => { resolveCapture = resolve; }));
      const pending = target.shareDeviceWhiteboard();
      if (change === 'permission revoked') { allowStudent(store, false); target.applyLocalParticipantPermissionsPatch('student', { canShareScreen: false }); }
      else { handlers.get('disconnect')!(); }
      const candidate = stream(); resolveCapture(candidate); await pending;
      expect(candidate.getVideoTracks()[0]!.readyState).toBe('ended');
      expect(webrtc.publish).not.toHaveBeenCalled();
      expect(webrtc.screenStream()).toBeNull();
      expect(target.deviceSharing()).toBeFalse();
    });
  }

  it('stops student capture locally on permission revoke without stopping camera or microphone producers', async () => {
    const { target, store, webrtc, socket } = setup('student'); allowStudent(store);
    const camera = stream(); webrtc.localStream.set(camera);
    target.localProducerIds.set(['student-camera']);
    await target.shareDeviceWhiteboard();
    const shared = webrtc.screenStream()!;
    allowStudent(store, false); target.applyLocalParticipantPermissionsPatch('student', { canShareScreen: false });
    expect(shared.getVideoTracks()[0]!.readyState).toBe('ended');
    expect(camera.getVideoTracks()[0]!.readyState).toBe('live');
    expect(target.localProducerIds()).toEqual(['student-camera']);
    expect(webrtc.releaseLocalProducer).toHaveBeenCalledWith('new-source');
    expect(socket.emitAck).not.toHaveBeenCalledWith('screen:stop', jasmine.anything());
  });

  it('stops active student capture on raw disconnect and requires a fresh grant before another capture', async () => {
    const { target, store, webrtc, handlers, socket } = setup('student'); allowStudent(store);
    target.bindSocketConnectionEvents();
    await target.shareDeviceWhiteboard();
    const shared = webrtc.screenStream()!;
    handlers.get('disconnect')!();
    expect(shared.getVideoTracks()[0]!.readyState).toBe('ended');
    expect(target.canShareDevice()).toBeFalse();
    expect(target.deviceSharingConnected()).toBeFalse();
    await target.requestDeviceSharing(); await target.shareDeviceWhiteboard();
    expect(socket.emitAck).not.toHaveBeenCalled();
    expect(webrtc.captureScreen).toHaveBeenCalledTimes(1);
  });

  it('ends the student share when the selected window closes', async () => {
    const { target, store, webrtc, socket } = setup('student'); allowStudent(store);
    await target.shareDeviceWhiteboard();
    const shared = webrtc.screenStream()!;
    shared.getVideoTracks()[0]!.dispatchEvent(new Event('ended'));
    expect(shared.getVideoTracks()[0]!.readyState).toBe('ended');
    expect(target.deviceSharing()).toBeFalse();
    expect(socket.emitAck).toHaveBeenCalledWith('screen:stop', { producerId: 'new-source' });
  });

  it('stops student capture when a room snapshot removes its producer', async () => {
    const { target, store, webrtc } = setup('student'); allowStudent(store);
    await target.shareDeviceWhiteboard();
    const shared = webrtc.screenStream()!;
    target.cleanupRemovedRoomProducers({ ...store.room(), producers: [] });
    expect(shared.getVideoTracks()[0]!.readyState).toBe('ended');
    expect(target.deviceSharing()).toBeFalse();
  });

  it('shows a student device centrally, then falls back to the preserved teacher board', () => {
    const { target, store, webrtc } = setup('student');
    const teacherBoard = stream(); const peerBoard = stream();
    store.upsertProducer(producer('teacher-board', 'teacher', 'whiteboard') as any);
    store.upsertProducer(producer('peer-device', 'peer') as any);
    webrtc.remoteStreams.set([{ producerId: 'teacher-board', stream: teacherBoard }, { producerId: 'peer-device', stream: peerBoard }]);
    expect(target.stageStream()).toBe(peerBoard);
    expect(target.stageTitle()).toContain('Peer');
    expect(target.stageStatusText()).toContain('viewing only');
    store.removeProducer('peer-device');
    expect(target.stageStream()).toBe(teacherBoard);
    expect(target.stageTitle()).toContain('whiteboard');
  });
});

describe('Shared whiteboard source control', () => {
  it('exposes request, cancellation, approved share and stop states with accessible buttons', () => {
    const fixture = TestBed.createComponent(WhiteboardSourceControl);
    fixture.componentRef.setInput('student', true); fixture.componentRef.setInput('source', 'device'); fixture.componentRef.setInput('canShare', false);
    fixture.detectChanges();
    const request = jasmine.createSpy(); fixture.componentInstance.request.subscribe(request);
    const button = () => fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(fixture.nativeElement.querySelector('select').getAttribute('aria-label')).toBe('Whiteboard source');
    expect(button().textContent).toContain('Request device sharing'); button().click(); expect(request).toHaveBeenCalled();
    fixture.componentRef.setInput('requestPending', true); fixture.detectChanges(); expect(button().textContent).toContain('Cancel sharing request');
    fixture.componentRef.setInput('canShare', true); fixture.detectChanges(); expect(button().textContent).toContain('Share device whiteboard');
    fixture.componentRef.setInput('sharing', true); fixture.detectChanges(); expect(button().textContent).toContain('Stop device sharing');
  });
});
