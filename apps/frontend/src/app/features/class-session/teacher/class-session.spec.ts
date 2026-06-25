import { NO_ERRORS_SCHEMA, signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import type { LiveClassSettings } from '@native-sfu/contracts';
import { of } from 'rxjs';
import { AuthService } from '../../../core/services/auth.service';
import { RoomStore } from '../../../core/services/room.store';
import { SocketService } from '../../../core/services/socket.service';
import { WebRtcService } from '../../../core/services/webrtc.service';
import { ClassSessionService, type ClassroomPayload } from '../class-session.service';
import { TeacherClassSession } from './class-session';

describe('TeacherClassSession participant cards', () => {
  let fixture: ComponentFixture<TeacherClassSession>;
  let routerMock: { navigate: jasmine.Spy };
  let classSessionsMock: {
    getSession: jasmine.Spy;
    startSession: jasmine.Spy;
    endSession: jasmine.Spy;
    errorMessage(error: unknown): string;
  };
  let socketServiceMock: { connect(): unknown; emitAck: jasmine.Spy };
  let webrtcMock: {
    networkScore: WritableSignal<number>;
    devices: WritableSignal<{ audioInputs: unknown[]; videoInputs: unknown[] }>;
    lastMediaError: WritableSignal<null>;
    localStream: WritableSignal<MediaStream | null>;
    remoteStreams: WritableSignal<unknown[]>;
    screenStream: WritableSignal<MediaStream | null>;
    refreshDevices: jasmine.Spy;
    startCamera: jasmine.Spy;
    stopCamera: jasmine.Spy;
    switchMicrophone: jasmine.Spy;
    switchCamera: jasmine.Spy;
    preparePeer: jasmine.Spy;
    publish: jasmine.Spy;
    resetRoomMedia: jasmine.Spy;
    removeRemoteProducer: jasmine.Spy;
    recordAutoplayBlocked: jasmine.Spy;
    clearMediaIssue: jasmine.Spy;
  };

  const payload: ClassroomPayload = {
    sessionId: 'session-1',
    batchId: 'batch-1',
    teacherId: 'teacher-user',
    title: 'Live Geometry',
    sessionNumber: 1,
    scheduledAt: '2026-06-23T10:00:00.000Z',
    durationMinutes: 60,
    status: 'live',
    roomId: '',
    chatChannelId: 'chat-1',
    whiteboardChannelId: 'whiteboard-1',
    channels: {
      chat: 'chat-1',
      whiteboard: 'whiteboard-1'
    },
    role: 'teacher',
    canJoin: true,
    participants: [],
    resolvedLiveSettings: createLiveClassSettings()
  };

  beforeEach(async () => {
    const socket = {
      connected: true,
      on: jasmine.createSpy('on'),
      off: jasmine.createSpy('off'),
      once: jasmine.createSpy('once')
    };
    const localStream = signal<MediaStream | null>(null);
    const createPreviewStream = () => {
      const stream = new MediaStream();
      localStream.set(stream);
      return stream;
    };
    routerMock = { navigate: jasmine.createSpy('navigate') };
    classSessionsMock = {
      getSession: jasmine.createSpy('getSession').and.returnValue(of(payload)),
      startSession: jasmine.createSpy('startSession').and.returnValue(of(payload)),
      endSession: jasmine.createSpy('endSession').and.returnValue(of(payload)),
      errorMessage: (error: unknown) => (error instanceof Error ? error.message : 'Unable to load class session.')
    };
    socketServiceMock = {
      connect: () => socket,
      emitAck: jasmine.createSpy('emitAck').and.returnValue(Promise.resolve())
    };
    webrtcMock = {
      networkScore: signal(5),
      devices: signal({ audioInputs: [], videoInputs: [] }),
      lastMediaError: signal(null),
      localStream,
      remoteStreams: signal([]),
      screenStream: signal(null),
      refreshDevices: jasmine.createSpy('refreshDevices').and.returnValue(Promise.resolve()),
      startCamera: jasmine.createSpy('startCamera').and.callFake(() => Promise.resolve(createPreviewStream())),
      stopCamera: jasmine.createSpy('stopCamera').and.callFake(() => localStream.set(null)),
      switchMicrophone: jasmine.createSpy('switchMicrophone').and.callFake(() => Promise.resolve(createPreviewStream())),
      switchCamera: jasmine.createSpy('switchCamera').and.callFake(() => Promise.resolve(createPreviewStream())),
      preparePeer: jasmine.createSpy('preparePeer').and.returnValue(Promise.resolve({ id: 'transport-1' })),
      publish: jasmine.createSpy('publish').and.returnValue(Promise.resolve({ id: 'producer-1', kind: 'video' })),
      resetRoomMedia: jasmine.createSpy('resetRoomMedia'),
      removeRemoteProducer: jasmine.createSpy('removeRemoteProducer'),
      recordAutoplayBlocked: jasmine.createSpy('recordAutoplayBlocked').and.returnValue({
        code: 'autoplay_blocked',
        severity: 'warning',
        kind: 'audio',
        operation: 'autoplay',
        message: 'Browser blocked audio playback.',
        recoverable: true,
        actionLabel: 'Enable audio'
      }),
      clearMediaIssue: jasmine.createSpy('clearMediaIssue')
    };

    await TestBed.configureTestingModule({
      imports: [TeacherClassSession],
      providers: [
        RoomStore,
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: {
                get: (key: string) => (key === 'sessionId' ? 'session-1' : key === 'batchId' ? 'batch-1' : null)
              }
            }
          }
        },
        { provide: Router, useValue: routerMock },
        { provide: AuthService, useValue: { user: signal({ id: 'teacher-user', name: 'Teacher One' }) } },
        { provide: ClassSessionService, useValue: classSessionsMock },
        { provide: SocketService, useValue: socketServiceMock },
        { provide: WebRtcService, useValue: webrtcMock }
      ],
      schemas: [NO_ERRORS_SCHEMA]
    })
      .overrideComponent(TeacherClassSession, {
        set: {
          imports: [],
          schemas: [NO_ERRORS_SCHEMA]
        }
      })
      .compileComponents();

    fixture = TestBed.createComponent(TeacherClassSession);
    fixture.detectChanges();
  });

  it('shows teacher preflight before publishing an already-live session', () => {
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('.teacher-preflight-backdrop')).not.toBeNull();
    expect(socketServiceMock.emitAck).not.toHaveBeenCalledWith('room:join', jasmine.anything());
    expect(webrtcMock.preparePeer).not.toHaveBeenCalled();
    expect(webrtcMock.publish).not.toHaveBeenCalled();
  });

  it('calls manual start only after preflight confirmation for scheduled sessions', () => {
    const component = fixture.componentInstance as unknown as {
      session: { set(value: ClassroomPayload): void };
      preflightOpen: { set(value: boolean): void };
      preflightPreparing: { set(value: boolean): void };
      preflightActionPending: { set(value: boolean): void };
      preflightSocketReady: { set(value: boolean): void };
      confirmPreflight(): void;
    };
    component.session.set({ ...payload, status: 'scheduled' });
    component.preflightOpen.set(true);
    component.preflightPreparing.set(false);
    component.preflightActionPending.set(false);
    component.preflightSocketReady.set(true);
    webrtcMock.localStream.set(createReadyPreviewStream());

    expect(classSessionsMock.startSession).not.toHaveBeenCalled();

    component.confirmPreflight();

    expect(classSessionsMock.startSession).toHaveBeenCalledOnceWith('session-1', 'batch-1');
  });

  it('stops preview media when preflight is cancelled', async () => {
    const component = fixture.componentInstance as unknown as {
      cancelPreflight(): Promise<void>;
    };
    webrtcMock.stopCamera.calls.reset();

    await component.cancelPreflight();

    expect(webrtcMock.stopCamera).toHaveBeenCalled();
    expect(routerMock.navigate).toHaveBeenCalledWith(['/teacher/dashboard/batches', 'batch-1']);
  });

  it('uses an app confirmation modal for ending the class', () => {
    const confirmSpy = spyOn(globalThis, 'confirm').and.returnValue(true);
    const component = fixture.componentInstance as unknown as {
      endSession(): void;
      confirmationDialog: () => { title: string; variant: string; confirmLabel: string; pendingLabel: string } | null;
    };

    component.endSession();
    fixture.detectChanges();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(component.confirmationDialog()).toEqual(jasmine.objectContaining({
      title: 'End class for everyone?',
      variant: 'danger',
      confirmLabel: 'End session',
      pendingLabel: 'Ending...'
    }));
    expect((fixture.nativeElement as HTMLElement).querySelector('.teacher-confirm-modal')).not.toBeNull();
  });

  it('cancels the end confirmation without calling the backend', () => {
    const component = fixture.componentInstance as unknown as {
      endSession(): void;
      cancelConfirmation(): void;
      confirmationDialog: () => { title: string } | null;
    };

    component.endSession();
    component.cancelConfirmation();

    expect(classSessionsMock.endSession).not.toHaveBeenCalled();
    expect(component.confirmationDialog()).toBeNull();
  });

  it('opens confirmation modal before stopping all student cameras', async () => {
    const confirmSpy = spyOn(globalThis, 'confirm').and.returnValue(true);
    const component = fixture.componentInstance as unknown as {
      session: { set(value: ClassroomPayload): void };
      participants: { set(value: unknown[]): void };
      roomJoined: { set(value: boolean): void };
      stopAllStudentCameras(): Promise<void>;
      confirmationDialog: () => { title: string; variant: string; pendingLabel: string } | null;
    };
    component.session.set({ ...payload, roomId: 'room-1' });
    component.roomJoined.set(true);
    component.participants.set([
      {
        id: 'student-participant',
        name: 'Student One',
        role: 'Student',
        isStudent: true,
        canModerate: true,
        initials: 'SO',
        muted: false,
        cameraOff: false,
        screenSharing: false,
        connected: true
      }
    ]);

    await component.stopAllStudentCameras();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(socketServiceMock.emitAck).not.toHaveBeenCalledWith('class:stop-all-cameras', jasmine.anything());
    expect(component.confirmationDialog()).toEqual(jasmine.objectContaining({
      title: 'Stop all student cameras?',
      variant: 'warning',
      pendingLabel: 'Stopping cameras...'
    }));
  });

  it('opens confirmation modal before starting recording', () => {
    const confirmSpy = spyOn(globalThis, 'confirm').and.returnValue(true);
    const component = fixture.componentInstance as unknown as {
      startRecording(): void;
      confirmationDialog: () => { title: string; variant: string; pendingLabel: string } | null;
    };

    component.startRecording();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(classSessionsMock.startSession).not.toHaveBeenCalled();
    expect(component.confirmationDialog()).toEqual(jasmine.objectContaining({
      title: 'Start class recording?',
      variant: 'warning',
      pendingLabel: 'Starting recording...'
    }));
  });

  it('closes confirmation modal on Escape', () => {
    const component = fixture.componentInstance as unknown as {
      endSession(): void;
      confirmationDialog: () => { title: string } | null;
    };

    component.endSession();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(component.confirmationDialog()).toBeNull();
    expect(classSessionsMock.endSession).not.toHaveBeenCalled();
  });

  it('opens device and class controls drawers on demand', () => {
    const component = fixture.componentInstance as unknown as {
      openMediaDrawer(mode: 'devices' | 'controls'): void;
      mediaDrawerOpen: () => boolean;
      mediaDrawerMode: () => 'devices' | 'controls';
    };

    component.openMediaDrawer('devices');
    expect(component.mediaDrawerOpen()).toBeTrue();
    expect(component.mediaDrawerMode()).toBe('devices');

    component.openMediaDrawer('controls');
    expect(component.mediaDrawerOpen()).toBeTrue();
    expect(component.mediaDrawerMode()).toBe('controls');
  });

  it('renders moderation controls only for student participant cards', () => {
    const component = fixture.componentInstance as unknown as {
      participants: { set(value: unknown[]): void };
      roomJoined: { set(value: boolean): void };
    };
    component.roomJoined.set(true);
    component.participants.set([
      {
        id: 'student-participant',
        name: 'Student One',
        role: 'Student',
        isStudent: true,
        canModerate: true,
        initials: 'SO',
        muted: false,
        cameraOff: false,
        screenSharing: false,
        connected: true
      },
      {
        id: 'offline-student',
        name: 'Offline Student',
        role: 'Student',
        isStudent: true,
        canModerate: false,
        initials: 'OS',
        muted: false,
        cameraOff: false,
        screenSharing: false,
        connected: false
      },
      {
        id: 'teacher-participant',
        name: 'Teacher One',
        role: 'Teacher',
        isStudent: false,
        canModerate: false,
        initials: 'TO',
        muted: false,
        cameraOff: false,
        screenSharing: false,
        connected: true
      },
      {
        id: 'admin-participant',
        name: 'Admin One',
        role: 'Admin',
        isStudent: false,
        canModerate: false,
        initials: 'AO',
        muted: false,
        cameraOff: false,
        screenSharing: false,
        connected: true
      },
      {
        id: 'cohost-participant',
        name: 'Co-host One',
        role: 'Co-host',
        isStudent: false,
        canModerate: false,
        initials: 'CO',
        muted: false,
        cameraOff: false,
        screenSharing: false,
        connected: true
      }
    ]);

    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const cards = Array.from(root.querySelectorAll('.participant-card')) as HTMLElement[];
    expect(cards.length).toBe(5);
    const studentCard = cards[0]!;
    const offlineStudentCard = cards[1]!;
    const teacherCard = cards[2]!;
    const adminCard = cards[3]!;
    const cohostCard = cards[4]!;
    expect(studentCard.querySelectorAll('.participant-controls .control-button').length).toBe(4);
    expect(offlineStudentCard.querySelector('.participant-controls')).toBeNull();
    expect(teacherCard.querySelector('.participant-controls')).toBeNull();
    expect(adminCard.querySelector('.participant-controls')).toBeNull();
    expect(cohostCard.querySelector('.participant-controls')).toBeNull();
    expect(cards.slice(1).every((card) => Boolean(card.querySelector('.participant-staff-badge')))).toBeTrue();
  });

  it('keeps teacher chat threads student-only', () => {
    const component = fixture.componentInstance as unknown as {
      participants: { set(value: unknown[]): void };
      chatThreadParticipants: () => Array<{ id: string; name: string; initials: string; role: string }>;
    };
    component.participants.set([
      {
        id: 'student-participant',
        name: 'Student One',
        role: 'Student',
        isStudent: true,
        canModerate: true,
        initials: 'SO',
        muted: false,
        cameraOff: false,
        screenSharing: false,
        connected: true
      },
      {
        id: 'offline-student',
        name: 'Offline Student',
        role: 'Student',
        isStudent: true,
        canModerate: false,
        initials: 'OS',
        muted: false,
        cameraOff: false,
        screenSharing: false,
        connected: false
      },
      {
        id: 'teacher-participant',
        name: 'Teacher One',
        role: 'Teacher',
        isStudent: false,
        canModerate: false,
        initials: 'TO',
        muted: false,
        cameraOff: false,
        screenSharing: false,
        connected: true
      }
    ]);

    expect(component.chatThreadParticipants()).toEqual([
      {
        id: 'student-participant',
        name: 'Student One',
        initials: 'SO',
        role: 'Student'
      },
      {
        id: 'offline-student',
        name: 'Offline Student',
        initials: 'OS',
        role: 'Student'
      }
    ]);
  });
});

function createReadyPreviewStream(): MediaStream {
  const audioTrack = {
    kind: 'audio',
    readyState: 'live',
    getSettings: () => ({ deviceId: 'microphone-1' }),
    stop: jasmine.createSpy('stopAudio')
  } as unknown as MediaStreamTrack;
  const videoTrack = {
    kind: 'video',
    readyState: 'live',
    getSettings: () => ({ deviceId: 'camera-1' }),
    stop: jasmine.createSpy('stopVideo')
  } as unknown as MediaStreamTrack;
  return {
    getTracks: () => [audioTrack, videoTrack],
    getAudioTracks: () => [audioTrack],
    getVideoTracks: () => [videoTrack]
  } as unknown as MediaStream;
}

function createLiveClassSettings(): LiveClassSettings {
  return {
    media: {
      studentsJoinMuted: true,
      studentsJoinCameraOff: true,
      requirePrejoinDeviceCheck: true,
      allowStudentsToUnmuteSelf: true,
      allowStudentsToStartCameraSelf: true
    },
    chat: {
      privateTeacherStudentChatEnabled: true,
      teacherBroadcastEnabled: true,
      chatAttachmentsEnabled: true,
      messageLengthLimit: 2000
    },
    whiteboard: {
      whiteboardSharingEnabled: true,
      studentWhiteboardControlEnabled: true,
      maxActiveWhiteboardControllers: 1
    },
    speaking: {
      handRaiseEnabled: true,
      maxActiveSpeakers: 3,
      autoLowerHandAfterSpeakPermissionEnds: true
    },
    recording: {
      recordingEnabled: true,
      autoRecordOnStart: false,
      teacherManualRecordingControlEnabled: true,
      visibility: 'enrolled_students'
    },
    attendance: {
      presentThresholdMinutes: 10,
      presentThresholdPercentage: 50,
      lateJoinThresholdMinutes: 10,
      countReconnects: true,
      teacherAttendanceExportEnabled: true
    },
    access: {
      waitingRoomEnabled: false,
      lockClassAfterTeacherStarts: false,
      allowEnrolledStudentReconnectAfterLock: true,
      teacherReconnectGraceMessagingEnabled: true
    },
    materials: {
      materialsEnabled: true,
      teacherCanUploadMaterials: true,
      studentsCanDownloadMaterials: true,
      publishMaterialsBeforeClass: false,
      publishMaterialsAfterClass: true,
      allowedMaterialTypes: ['pdf', 'image', 'document', 'slides', 'link', 'file'],
      maxMaterialFileSizeMb: 10
    },
    notifications: {
      classReminderEnabled: true,
      classReminderMinutesBefore: 30,
      notifyWhenTeacherStarts: true,
      notifyRecordingAvailable: true,
      notifyNewMaterialUploaded: true,
      notifyMissedClass: false
    },
    questionQueue: {
      questionQueueEnabled: true,
      allowAnonymousQuestions: false,
      allowStudentUpvotes: true,
      teacherCanMarkAnswered: true,
      maxOpenQuestionsPerStudent: 3
    },
    recordingRetention: {
      recordingRetentionDays: 30,
      allowTeacherPublishRecording: false,
      allowStudentsDownloadRecording: true,
      autoArchiveExpiredRecordings: true
    },
    studentScreenShare: {
      studentScreenShareEnabled: false,
      studentScreenShareRequiresApproval: true,
      maxActiveStudentShares: 1
    },
    advancedAnalytics: {
      analyticsEnabled: true,
      trackEngagementEvents: true,
      trackMediaQuality: true,
      trackChatParticipation: true,
      trackWhiteboardParticipation: true,
      trackQuestionParticipation: true,
      analyticsVisibility: 'admin_and_teacher'
    },
    inactiveDetection: {
      inactiveDetectionEnabled: false,
      inactiveAfterMinutes: 10,
      countBackgroundTabAsInactive: true,
      countMutedNoCameraAsInactive: false,
      notifyTeacherOnInactiveStudents: true,
      includeInactiveTimeInAttendance: false
    },
    bandwidthPolicy: {
      adaptiveQualityEnabled: true,
      lowBandwidthModeEnabled: false,
      maxStudentVideoQuality: 'auto',
      maxScreenShareQuality: 'auto',
      disableStudentVideoOnPoorNetwork: false,
      preferAudioOnPoorNetwork: true,
      showNetworkWarnings: true
    },
    exportControls: {
      exportControlsEnabled: true,
      allowAttendanceExport: true,
      allowChatExport: false,
      allowQuestionExport: false,
      allowRecordingDownload: true,
      includePrivateChatInExports: false,
      anonymizeStudentExports: false,
      exportRetentionDays: 365,
      requireExportAuditLog: true
    }
  };
}
