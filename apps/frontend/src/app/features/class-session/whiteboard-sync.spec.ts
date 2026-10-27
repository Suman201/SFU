import { signal } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import { StudentClassSession } from './student/class-session';
import { TeacherClassSession } from './teacher/class-session';

const session = { sessionId: 'session', batchId: 'batch', roomId: 'room', whiteboardChannelId: 'channel', status: 'live' };
const snapshot = () => ({ schemaVersion: 1, activePageId: 'page', pages: [{ id: 'page', title: 'Page', order: 0, tags: [], elements: [] }] });
const state = () => ({ ...session, schemaVersion: 1, snapshotVersion: 0, lastOperationSeq: 0, snapshot: snapshot(), summary: { pageCount: 1, elementCount: 0, pages: [] }, createdAt: '', updatedAt: '' });
const event = (seq = 1) => ({ roomId: 'room', participantId: 'teacher', displayName: 'Teacher', operationSeq: seq, snapshotVersion: seq, command: { type: 'upsert', pageId: 'page', element: { id: `stroke-${seq}`, type: 'stroke' } } });

describe('Whiteboard session synchronization', () => {
  function student(): any {
    const target: any = Object.create(StudentClassSession.prototype);
    let visible: any = snapshot();
    Object.assign(target, {
      auth: { user: () => ({ id: 'student' }) }, recoveryStore: { put: async () => {}, get: async () => undefined, list: async () => [], remove: async () => {} }, recoveredWhiteboardChanges: signal(0), whiteboardControlNotice: signal(''),
      session: signal(session), store: { localParticipantId: () => 'student' }, joinedRoomIdState: signal(''), joinedRoomId: 'room',
      liveWhiteboardState: signal(state()), whiteboardSocketConnected: signal(true), whiteboardMemoryApplying: false, whiteboardMemoryLoadEvents: null,
      pendingWhiteboardCommands: [], pendingLocalWhiteboardCommands: new Map(), whiteboardCommandTail: Promise.resolve(), whiteboardMemoryLoadedSessionId: '', destroyed: false, whiteboardMemoryRequestId: 0, whiteboardMemoryLoading: signal(false), whiteboardControlGranted: () => false,
      whiteboardDrawerOpen: signal(true), whiteboardAvailable: () => true, participantsOpen: signal(false), materialsOpen: signal(false),
      interactiveWhiteboard: {
        applyCommand(command: any) { visible.pages[0].elements.push(command.element); },
        importBoardState(value: any) { visible = structuredClone(value); },
        requestCaptureFrame() {}, exportBoardState: () => visible
      }
    });
    return target;
  }

  it('retains received strokes when the student closes and reopens the drawer', async () => {
    const target = student();
    target.applyRemoteWhiteboardCommand(event());
    target.closeWhiteboardDrawer();
    target.toggleWhiteboardDrawer();
    await new Promise(resolve => setTimeout(resolve));
    expect(target.interactiveWhiteboard.exportBoardState().pages[0].elements.map((item: any) => item.id)).toEqual(['stroke-1']);
  });

  it('replays events received while a snapshot request is in flight', async () => {
    const target = student();
    const response = new Subject<any>();
    target.classSessions = { getWhiteboardMemory: () => response };
    target.loadLiveWhiteboardMemory(session, true);
    target.applyRemoteWhiteboardCommand(event(2));
    const baseline: any = state();
    baseline.lastOperationSeq = 1;
    baseline.snapshot.pages[0].elements = [event(1).command.element];
    response.next(baseline);
    await new Promise(resolve => setTimeout(resolve));
    expect(target.liveWhiteboardState().snapshot.pages[0].elements.map((item: any) => item.id)).toEqual(['stroke-1', 'stroke-2']);
  });

  it('tracks manual student navigation for current-page permissions without replacing remote elements', () => {
    const target = student();
    target.interactiveWhiteboard.currentPageId = () => 'other-page';
    target.handleStudentWhiteboardStateChanged();
    expect(target.liveWhiteboardState().snapshot.activePageId).toBe('other-page');
    expect(target.liveWhiteboardState().snapshot.pages.length).toBe(1);
  });

  it('ignores an older snapshot response after a newer reload completes', async () => {
    const target = student();
    const first = new Subject<any>();
    const second = new Subject<any>();
    target.classSessions = { getWhiteboardMemory: jasmine.createSpy().and.returnValues(first, second) };
    target.loadLiveWhiteboardMemory(session, true);
    target.loadLiveWhiteboardMemory(session, true);
    second.next({ ...state(), snapshotVersion: 2, lastOperationSeq: 2 });
    first.next(state());
    await new Promise(resolve => setTimeout(resolve));
    expect(target.liveWhiteboardState().snapshotVersion).toBe(2);
  });

  it('refetches a snapshot when buffered events contain a sequence gap', async () => {
    const target = student();
    const first = new Subject<any>();
    const retry = new Subject<any>();
    target.classSessions = { getWhiteboardMemory: jasmine.createSpy().and.returnValues(first, retry) };
    target.loadLiveWhiteboardMemory(session, true);
    target.applyRemoteWhiteboardCommand(event(2));
    first.next(state());
    expect(target.liveWhiteboardState().lastOperationSeq).toBe(0);
    expect(target.classSessions.getWhiteboardMemory).toHaveBeenCalledTimes(2);
    const recovered: any = state();
    recovered.lastOperationSeq = 2;
    recovered.snapshot.pages[0].elements = [event(1).command.element, event(2).command.element];
    retry.next(recovered);
    await new Promise(resolve => setTimeout(resolve));
    expect(target.liveWhiteboardState().snapshot.pages[0].elements.map((item: any) => item.id)).toEqual(['stroke-1', 'stroke-2']);
  });

  it('keeps an in-flight student stroke visible across snapshot refresh and its later ACK', async () => {
    const target = student();
    const response = new Subject<any>();
    let acknowledge!: (value: any) => void;
    target.socket = { emitAck: () => new Promise(resolve => { acknowledge = resolve; }) };
    target.classSessions = { getWhiteboardMemory: () => response };
    target.whiteboardControlGranted = () => true;
    target.sessionLive = () => true;
    target.whiteboardLocked = () => false;
    target.whiteboardPermissionLevel = () => 'draw';
    target.whiteboardPermittedPageId = () => 'page';
    target.createWhiteboardOperationId = () => 'own-operation';
    target.handleStudentWhiteboardCommand(event().command);
    target.loadLiveWhiteboardMemory(session, true);
    response.next(state());
    await new Promise(resolve => setTimeout(resolve));
    expect(target.interactiveWhiteboard.exportBoardState().pages[0].elements.map((item: any) => item.id)).toEqual(['stroke-1']);
    acknowledge({ ...event(), participantId: 'student' });
    await Promise.resolve();
    expect(target.interactiveWhiteboard.exportBoardState().pages[0].elements.map((item: any) => item.id)).toEqual(['stroke-1']);
  });

  it('publishes private preparation before any live snapshot refresh can replace it', async () => {
    const target = teacher();
    target.privatePreparation.set(true);
    const prepared: any = snapshot(); prepared.pages[0].elements = [event().command.element];
    target.whiteboard.importBoardState(prepared);
    const baseline = new Subject<any>();
    target.classSessions.getWhiteboardMemory = jasmine.createSpy().and.returnValue(baseline);
    target.socket = { emitAck: jasmine.createSpy().and.resolveTo({}) };
    target.loadWhiteboardMemory(session, true);
    expect(target.classSessions.getWhiteboardMemory).not.toHaveBeenCalled();
    const published = target.publishPrivateWhiteboard(session);
    target.loadWhiteboardMemory(session, true);
    expect(target.classSessions.getWhiteboardMemory).toHaveBeenCalledTimes(1);
    baseline.next(state());
    expect(await published).toBeTrue();
    expect(target.whiteboard.exportBoardState().pages[0].elements.map((item: any) => item.id)).toEqual(['stroke-1']);
    expect(target.classSessions.saveWhiteboardMemory).toHaveBeenCalledWith('session', jasmine.objectContaining({ snapshot: prepared, expectedSnapshotVersion: 0, expectedLastOperationSeq: 0 }));
    expect(target.socket.emitAck).toHaveBeenCalledWith('whiteboard:refresh', { roomId: 'room' });
    expect(target.privatePreparation()).toBeFalse();
  });

  it('keeps the prepared board and a recovery action when publishing fails', async () => {
    const target = teacher(); target.privatePreparation.set(true);
    const prepared: any = snapshot(); prepared.pages[0].elements = [event().command.element]; target.whiteboard.importBoardState(prepared);
    target.classSessions.getWhiteboardMemory = () => throwError(() => new Error('offline'));
    expect(await target.publishPrivateWhiteboard(session)).toBeFalse();
    expect(target.whiteboard.exportBoardState()).toEqual(prepared);
    expect(target.localDraft().snapshot).toEqual(prepared);
    expect(target.whiteboardSaveConflict()).toBeTrue();
  });

  it('stops only the matching local capture when another classroom window ends recording', async () => {
    const target = teacher();
    target.applyRecording = jasmine.createSpy(); target.mediaNotice = signal('');
    target.lessonRecorder = { activeId: () => 'active-recording', stop: jasmine.createSpy().and.resolveTo() };
    target.applyRecordingEvent({ sessionId: 'session', status: 'stopped', recording: { recordingId: 'older-recording', status: 'stopped' } });
    expect(target.lessonRecorder.stop).not.toHaveBeenCalled();
    target.applyRecordingEvent({ sessionId: 'session', status: 'stopped', recording: { recordingId: 'active-recording', status: 'stopped' } });
    expect(target.lessonRecorder.stop).toHaveBeenCalledTimes(1);
    target.applyRecordingEvent({ sessionId: 'session', status: 'failed', recording: { recordingId: 'active-recording', status: 'failed' } });
    expect(target.lessonRecorder.stop).toHaveBeenCalledTimes(2);
    await Promise.resolve();
  });

  it('retries the server baseline before restoring a private draft whose initial load failed', async () => {
    const target = teacher(); target.whiteboardMemoryReady = false;
    const prepared: any = snapshot(); prepared.pages[0].elements = [event().command.element];
    target.localDraft.set({ snapshot: prepared, savedAt: '' });
    target.classSessions.getWhiteboardMemory = jasmine.createSpy().and.returnValue(of(state()));
    target.socket = { emitAck: jasmine.createSpy().and.resolveTo({}) };
    await target.restoreLocalDraft();
    expect(target.classSessions.getWhiteboardMemory).toHaveBeenCalled();
    expect(target.classSessions.saveWhiteboardMemory).toHaveBeenCalledWith('session', jasmine.objectContaining({ snapshot: prepared }));
    expect(target.localDraft()).toBeNull();
  });

  function teacher(): any {
    const target: any = Object.create(TeacherClassSession.prototype);
    let visible: any = snapshot();
    Object.assign(target, {
      auth: { user: () => ({ id: 'teacher' }) }, privatePreparation: signal(false), localDraft: signal(null), recoveryStore: { put: async () => {}, get: async () => undefined, remove: async () => {} },
      session: signal(session), whiteboardMemoryState: signal(state()), whiteboardSaveConflict: signal(false),
      whiteboardMemorySaveState: signal('idle'), whiteboardMemoryNotice: signal(''), mediaError: signal(''),
      destroyed: false, whiteboardMemoryRequestId: 0, whiteboardMemoryLoadEvents: null, whiteboardMemoryLoadedSessionId: 'session',
      store: { localParticipantId: () => 'teacher' }, isCurrentRoom: (id: string) => id === 'room', trackStudentWhiteboardCommand() {},
      whiteboardMemoryReady: true, whiteboardMemoryApplying: false, whiteboardSyncTail: Promise.resolve(), whiteboardEditRevision: 0,
      whiteboard: { exportBoardState: () => visible, importBoardState: (value: any) => { visible = structuredClone(value); }, requestCaptureFrame() {}, applyCommand: (command: any) => { visible.pages[0].elements.push(command.element); } }, currentRoomId: () => 'room', sessionLive: () => true, roomJoined: () => true,
      scheduleWhiteboardAutosave() {}, createWhiteboardOperationId: () => 'operation',
      classSessions: { saveWhiteboardMemory: jasmine.createSpy('save').and.callFake((_id: string, request: any) => of({ ...state(), snapshotVersion: 2, lastOperationSeq: 1, snapshot: request.snapshot })), errorMessage: () => 'Conflict' }
    });
    return target;
  }

  it('waits for a pending command ACK before capturing full-save concurrency tokens', async () => {
    const target = teacher();
    let acknowledge!: (value: any) => void;
    target.socket = { emitAck: () => new Promise(resolve => { acknowledge = resolve; }) };
    target.handleTeacherWhiteboardCommand(event().command);
    const saved = target.saveWhiteboardMemory();
    await Promise.resolve();
    expect(target.classSessions.saveWhiteboardMemory).not.toHaveBeenCalled();
    acknowledge(event());
    await saved;
    const request = target.classSessions.saveWhiteboardMemory.calls.mostRecent().args[1];
    expect(request.expectedSnapshotVersion).toBe(1);
    expect(request.expectedLastOperationSeq).toBe(1);
  });

  it('preserves the local board and blocks blind full-save retries after a conflict', async () => {
    const target = teacher();
    target.classSessions.saveWhiteboardMemory.and.returnValue(throwError(() => ({ status: 409 })));
    const before = target.whiteboard.exportBoardState();
    await target.saveWhiteboardMemory().catch(() => null);
    expect(target.whiteboardSaveConflict()).toBeTrue();
    expect(target.whiteboard.exportBoardState()).toEqual(before);
    await target.saveWhiteboardMemory();
    expect(target.classSessions.saveWhiteboardMemory).toHaveBeenCalledTimes(1);
  });

  it('does not advance trusted save tokens across missing operations', () => {
    const target = teacher();
    expect(target.updateWhiteboardRevision(event(2))).toBeFalse();
    expect(target.whiteboardSaveConflict()).toBeTrue();
    expect(target.whiteboardMemoryState().lastOperationSeq).toBe(0);
  });
  it('refreshes peers after a successful restore even when a concurrent edit preserves the local board', async () => {
    const target = teacher();
    target.whiteboardMemoryBusy = signal(false);
    target.clearWhiteboardAutosaveTimer = () => {};
    target.socket = { emitAck: jasmine.createSpy('refresh').and.returnValue(Promise.resolve({ roomId: 'room', participantId: 'teacher' })) };
    target.whiteboard.importBoardState = jasmine.createSpy('import');
    const restored = new Subject<any>();
    target.queueWhiteboardRestore(() => restored, 'Restored');
    await Promise.resolve();
    target.whiteboardEditRevision += 1;
    restored.next({ ...state(), snapshotVersion: 1 });
    await target.whiteboardSyncTail;
    expect(target.socket.emitAck).toHaveBeenCalledWith('whiteboard:refresh', { roomId: 'room' });
    expect(target.whiteboardSaveConflict()).toBeTrue();
    expect(target.whiteboard.importBoardState).not.toHaveBeenCalled();
  });

  it('reloads the teacher board after reconnect only after pending commands are acknowledged', async () => {
    const target = teacher();
    let acknowledge!: (value: any) => void;
    target.whiteboardMemoryLoadEvents = [];
    target.socket = { emitAck: () => new Promise(resolve => { acknowledge = resolve; }) };
    target.classSessions.getWhiteboardMemory = jasmine.createSpy('reload').and.returnValue(of({ ...state(), snapshotVersion: 2, lastOperationSeq: 2 }));
    target.handleTeacherWhiteboardCommand(event(2).command);
    const reload = target.reloadWhiteboardAfterReconnect(session);
    await Promise.resolve();
    expect(target.classSessions.getWhiteboardMemory).not.toHaveBeenCalled();
    acknowledge(event(2));
    await reload;
    expect(target.classSessions.getWhiteboardMemory).toHaveBeenCalledOnceWith('session', { batchId: 'batch' });
    expect(target.whiteboardSaveConflict()).toBeFalse();
    expect(target.whiteboardMemoryState().lastOperationSeq).toBe(2);
  });

  it('preserves unsent offline teacher edits instead of replacing them on reconnect', async () => {
    const target = teacher();
    target.roomJoined = () => false;
    target.whiteboard.applyCommand(event().command);
    target.handleTeacherWhiteboardCommand(event().command);
    target.roomJoined = () => true;
    target.classSessions.getWhiteboardMemory = jasmine.createSpy('reload').and.returnValue(of(state()));
    await target.reloadWhiteboardAfterReconnect(session);
    expect(target.whiteboardSaveConflict()).toBeTrue();
    expect(target.classSessions.getWhiteboardMemory).not.toHaveBeenCalled();
    expect(target.whiteboard.exportBoardState().pages[0].elements.map((item: any) => item.id)).toEqual(['stroke-1']);
  });

  it('replays student strokes received during teacher reconnect snapshot loading', () => {
    const target = teacher();
    const response = new Subject<any>();
    target.classSessions.getWhiteboardMemory = () => response;
    target.loadWhiteboardMemory(session, true);
    target.applyRemoteWhiteboardCommand({ ...event(2), participantId: 'student' });
    const baseline: any = state();
    baseline.lastOperationSeq = 1;
    baseline.snapshot.pages[0].elements = [event(1).command.element];
    response.next(baseline);
    expect(target.whiteboardSaveConflict()).toBeFalse();
    expect(target.whiteboardMemoryState().lastOperationSeq).toBe(2);
    expect(target.whiteboard.exportBoardState().pages[0].elements.map((item: any) => item.id)).toEqual(['stroke-1', 'stroke-2']);
  });

  it('ignores an outdated teacher snapshot response after a newer reconnect reload', () => {
    const target = teacher();
    const first = new Subject<any>();
    const second = new Subject<any>();
    target.classSessions.getWhiteboardMemory = jasmine.createSpy('reload').and.returnValues(first, second);
    target.loadWhiteboardMemory(session, true);
    target.loadWhiteboardMemory(session, true);
    second.next({ ...state(), snapshotVersion: 2, lastOperationSeq: 2 });
    first.next(state());
    expect(target.whiteboardMemoryState().snapshotVersion).toBe(2);
  });

  it('rejoins students without leaving the room and reloads even a previously loaded session', async () => {
    const target = student();
    target.whiteboardMemoryLoadedSessionId = 'session';
    target.classSessions = { getWhiteboardMemory: jasmine.createSpy('reload').and.returnValue(of({ ...state(), lastOperationSeq: 1, snapshot: { ...snapshot(), pages: [{ ...snapshot().pages[0], elements: [event().command.element] }] } })) };
    target.joiningMedia = signal(false);
    target.mediaError = signal('');
    target.stopActivityHeartbeat = () => {};
    target.closeStudentProducers = async () => {};
    target.cleanupLocalMediaLocally = jasmine.createSpy('cleanup');
    target.leaveCurrentRoom = jasmine.createSpy('leave');
    target.studentDisplayName = () => 'Student';
    target.syncTeacherModerationFromLocalParticipant = () => {};
    target.syncLocalParticipantMediaState = () => {};
    target.startActivityHeartbeat = () => {};
    target.consumeAvailableTeacherProducers = async () => {};
    target.publishEnabledStudentMedia = async () => {};
    target.store.setRoom = () => {};
    target.store.setLocalParticipant = () => {};
    target.socket = { emitAck: jasmine.createSpy('join').and.returnValue(Promise.resolve({ room: {}, participantId: 'student' })) };
    await target.joinClassroomRoom(session, true);
    await new Promise(resolve => setTimeout(resolve));
    expect(target.leaveCurrentRoom).not.toHaveBeenCalled();
    expect(target.cleanupLocalMediaLocally).toHaveBeenCalledWith({ preserveMediaIntent: true, preserveWhiteboardState: true });
    expect(target.classSessions.getWhiteboardMemory).toHaveBeenCalledOnceWith('session', { batchId: 'batch' });
    expect(target.whiteboardDrawerOpen()).toBeTrue();
    expect(target.interactiveWhiteboard.exportBoardState().pages[0].elements.map((item: any) => item.id)).toEqual(['stroke-1']);
  });

  it('buffers restored student permission and lock events until the join identity is known', () => {
    const target = student();
    target.joiningWhiteboardRoom = true;
    target.pendingWhiteboardControlEvents = [];
    const granted = { roomId: 'room', participantId: 'new-student', granted: true, permissionLevel: 'draw' };
    const locked = { roomId: 'room', locked: true };
    target.applyWhiteboardControlEvent(granted);
    target.applyWhiteboardLockEvent(locked);
    expect(target.pendingWhiteboardControlEvents).toEqual([granted, locked]);
  });

  it('serializes student strokes and retries a lost ACK with the same operation ID', async () => {
    const target = student();
    const responses: Array<(value: any) => void> = [];
    target.socket = { emitAck: jasmine.createSpy('command').and.callFake(() => new Promise(resolve => { responses.push(resolve); })) };
    target.whiteboardControlGranted = () => true;
    target.sessionLive = () => true;
    target.whiteboardLocked = () => false;
    target.whiteboardPermissionLevel = () => 'draw';
    target.whiteboardPermittedPageId = () => 'page';
    target.whiteboardControlNotice = signal('');
    let operation = 0;
    target.createWhiteboardOperationId = () => `operation-${++operation}`;
    target.handleStudentWhiteboardCommand(event(1).command);
    target.handleStudentWhiteboardCommand(event(2).command);
    await new Promise(resolve => setTimeout(resolve));
    expect(target.socket.emitAck).toHaveBeenCalledTimes(1);
    responses[0]!(event(1));
    await new Promise(resolve => setTimeout(resolve));
    expect(target.socket.emitAck).toHaveBeenCalledTimes(2);
    responses[1]!(event(2));
    await target.whiteboardCommandTail;
    expect(target.liveWhiteboardState().lastOperationSeq).toBe(2);
    expect(target.pendingLocalWhiteboardCommands.size).toBe(0);

    let retries = 0;
    target.socket.emitAck.and.callFake(() => ++retries === 1 ? Promise.reject(new Error('ACK lost')) : Promise.resolve(event(3)));
    target.handleStudentWhiteboardCommand(event(3).command);
    await target.whiteboardCommandTail;
    const requests = target.socket.emitAck.calls.allArgs().slice(-2);
    expect(requests[0]![1].operationId).toBe(requests[1]![1].operationId);
    expect(target.liveWhiteboardState().lastOperationSeq).toBe(3);
  });

  it('pauses teacher autosaves and buffers missed commands on actual socket disconnect', () => {
    const target = teacher();
    target.joinedRoomId = 'room';
    target.whiteboardSharing = () => false;
    target.whiteboardLocked = signal(true);
    target.screenSharing = () => false;
    target.mediaNotice = signal('');
    target.clearWhiteboardAutosaveTimer = jasmine.createSpy('cancel-autosave');
    target.cleanupRoomMediaLocally = jasmine.createSpy('cleanup');
    target.syncParticipantsFromSession = () => {};
    target.store = { room: signal({ id: 'room' }), localParticipantId: signal('teacher') };
    const staleResponse = new Subject<any>();
    target.classSessions.getWhiteboardMemory = () => staleResponse;
    target.loadWhiteboardMemory(session, true);
    const previousRequest = target.whiteboardMemoryRequestId;
    target.handleSocketDisconnect();
    expect(target.clearWhiteboardAutosaveTimer).toHaveBeenCalled();
    expect(target.whiteboardMemoryReady).toBeFalse();
    expect(target.whiteboardLocked()).toBeFalse();
    expect(target.whiteboardMemorySaveState()).toBe('loading');
    expect(target.whiteboardMemoryLoadEvents).toEqual([]);
    expect(target.whiteboardMemoryRequestId).toBe(previousRequest + 1);
    staleResponse.next({ ...state(), snapshotVersion: 99 });
    expect(target.whiteboardMemoryState().snapshotVersion).toBe(0);
  });

  it('replaces the student placeholder page when the first authoritative command arrives', () => {
    const target = student();
    target.liveWhiteboardState.set(null);
    target.interactiveWhiteboard.importBoardState({ ...snapshot(), pages: [{ ...snapshot().pages[0], id: 'local-placeholder' }] });
    target.applyRemoteWhiteboardCommand(event(1));
    const visible = target.interactiveWhiteboard.exportBoardState();
    expect(visible.pages.map((page: any) => page.id)).toEqual(['page']);
    expect(visible.activePageId).toBe('page');
    expect(visible.pages[0].elements.map((item: any) => item.id)).toEqual(['stroke-1']);
  });

  it('does not overwrite recovered local work with an empty server bootstrap', async () => {
    const target = teacher();
    const draft = { snapshot: { ...snapshot(), pages: [{ ...snapshot().pages[0], elements: [event().command.element] }] }, savedAt: new Date().toISOString() };
    target.recoveryStore.get = async () => draft;
    target.classSessions.getWhiteboardMemory = () => of(null);
    target.sendWhiteboardSnapshot = jasmine.createSpy('bootstrap');
    target.loadWhiteboardMemory(session, true);
    await new Promise(resolve => setTimeout(resolve));
    expect(target.localDraft()).toEqual(draft);
    expect(target.sendWhiteboardSnapshot).not.toHaveBeenCalled();
  });

  it('replays recovered student edits in creation order instead of UUID order', async () => {
    const target = student();
    target.studentWhiteboardReadOnly = () => false;
    target.retryingWhiteboardChanges = signal(false);
    target.isStudentWhiteboardCommandAllowed = () => true;
    target.loadLiveWhiteboardMemory = () => {};
    target.socket = { emitAck: jasmine.createSpy('replay').and.resolveTo({}) };
    const entries = [
      { key: 'a', value: { operationId: 'a', sequence: 2, command: { type: 'delete', pageId: 'page', elementId: 'stroke-1' } } },
      { key: 'z', value: { operationId: 'z', sequence: 1, command: event().command } }
    ];
    target.recoveryStore.list = async () => entries.slice();
    await target.retryRecoveredStrokes();
    expect(target.socket.emitAck.calls.allArgs().map((args: any[]) => args[1].operationId)).toEqual(['z', 'a']);
  });

  it('bootstraps authoritative page metadata when no saved teacher board exists', async () => {
    const target = teacher();
    target.classSessions.getWhiteboardMemory = () => of(null);
    target.sendWhiteboardSnapshot = jasmine.createSpy('bootstrap').and.returnValue(Promise.resolve());
    target.loadWhiteboardMemory(session, true);
    expect(target.whiteboardMemoryState()).toBeNull();
    await new Promise(resolve => setTimeout(resolve));
    expect(target.sendWhiteboardSnapshot).toHaveBeenCalledOnceWith('room');
  });

  it('preserves the same student attempt across an authoritative grant replay with a new participant identity', () => {
    const target = teacher();
    target.studentWhiteboardAttempt = signal(null);
    target.whiteboard.elementRefs = () => [{ pageId: 'page', elementId: 'teacher-baseline' }];
    const grant = { roomId: 'room', participantId: 'student-old', displayName: 'Student', granted: true, permissionLevel: 'annotate', grantedAt: '2026-10-27T10:00:00.000Z' };
    target.startStudentWhiteboardAttempt(grant);
    const initial = target.studentWhiteboardAttempt();
    target.studentWhiteboardAttempt.set({ ...initial, status: 'revoked', endedAt: '2026-10-27T10:01:00.000Z', elementRefs: [{ pageId: 'page', elementId: 'student-stroke' }] });
    target.whiteboard.elementRefs = () => [{ pageId: 'page', elementId: 'teacher-baseline' }, { pageId: 'page', elementId: 'student-stroke' }];
    target.startStudentWhiteboardAttempt({ ...grant, participantId: 'student-new' });
    const restored = target.studentWhiteboardAttempt();
    expect(restored.attemptId).toBe(initial.attemptId);
    expect(restored.participantId).toBe('student-new');
    expect(restored.baselineKeys).toEqual(['page:teacher-baseline']);
    expect(restored.elementRefs).toEqual([{ pageId: 'page', elementId: 'student-stroke' }]);
    expect(restored.status).toBe('active');
    expect(restored.endedAt).toBeUndefined();
    target.startStudentWhiteboardAttempt({ ...grant, participantId: 'student-new', grantedAt: '2026-10-27T10:02:00.000Z' });
    expect(target.studentWhiteboardAttempt().elementRefs).toEqual([]);
    expect(target.studentWhiteboardAttempt().baselineKeys).toEqual(['page:teacher-baseline', 'page:student-stroke']);
  });

  it('does not reopen a kept student attempt when its grant is replayed', () => {
    const target = teacher();
    target.studentWhiteboardAttempt = signal(null);
    target.whiteboard.elementRefs = () => [];
    const grant = { roomId: 'room', participantId: 'student', displayName: 'Student', granted: true, permissionLevel: 'draw', grantedAt: '2026-10-27T10:00:00.000Z' };
    target.startStudentWhiteboardAttempt(grant);
    target.studentWhiteboardAttempt.set({ ...target.studentWhiteboardAttempt(), status: 'kept', endedAt: '2026-10-27T10:01:00.000Z' });
    target.startStudentWhiteboardAttempt(grant);
    expect(target.studentWhiteboardAttempt().status).toBe('kept');
    expect(target.studentWhiteboardAttempt().endedAt).toBe('2026-10-27T10:01:00.000Z');
  });

});
