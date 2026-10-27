import { WhiteboardSourceControl, type ClassroomWhiteboardSource } from '../../../shared/whiteboard-source/whiteboard-source';
import { DeviceSetupDialogComponent } from '../../../shared/device-setup/device-setup-dialog';
import { ClassroomConnectionTools } from '../../../shared/classroom-connection-tools/classroom-connection-tools';
import { firstValueFrom, type Observable } from 'rxjs';
import { LessonRecordingService } from '../../../core/services/lesson-recording.service';
import { ClassroomRecoveryStore } from '../../../core/services/classroom-recovery-store';
import { isDesktopSession } from '../../../core/services/desktop-bridge';
import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  ClassSessionLifecycleEvent,
  ClassSessionRecordingEvent,
  ClassStudentSpeakEvent,
  ClassStudentMediaModerationResponse,
  Consumer,
  Participant,
  ParticipantPatch,
  Producer,
  Recording,
  Room,
  ServerToClientEvents,
  StudentMediaModerationEvent,
  WhiteboardCommand as WireWhiteboardCommand,
  WhiteboardCommandEvent,
  WhiteboardControlEvent,
  WhiteboardCursorEvent,
  WhiteboardLockEvent,
  WhiteboardMemorySaveReason,
  WhiteboardMemoryState,
  WhiteboardMemoryVersion,
  WhiteboardPermissionLevel
} from '@native-sfu/contracts';
import type { PreviousWhiteboardMemorySummary } from '@native-sfu/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { RoomStore } from '../../../core/services/room.store';
import { SocketService } from '../../../core/services/socket.service';
import { WebRtcService, type DeviceOption } from '../../../core/services/webrtc.service';
import { MediaStreamDirective } from '../../../shared/media-stream/media-stream.directive';
import { ClassSessionService, type ClassroomPayload } from '../class-session.service';
import { Whiteboard, type WhiteboardCommand, type WhiteboardCursor, type WhiteboardElementRef } from '../../../shared/whiteboard/whiteboard';
import { SessionChat } from '../session-chat/session-chat';
import { SessionMaterials } from '../session-materials/session-materials';

interface SessionParticipant {
  id: string;
  name: string;
  role: 'Teacher' | 'Student' | 'Admin' | 'Co-host' | 'Viewer';
  isStudent: boolean;
  canModerate: boolean;
  initials: string;
  muted: boolean;
  cameraOff: boolean;
  screenSharing: boolean;
  handRaised: boolean;
  handRaisedAt?: string;
  allowedToSpeak: boolean;
  allowedToSpeakAt?: string;
  connected: boolean;
  inactive: boolean;
  inactiveSince?: string;
}

type DeviceIdSignal = (() => string | null) & { set(value: string | null): void };
type DeviceIdState = DeviceIdSignal | (() => string | null) | string | null | undefined;
type ParticipantMediaState = 'video' | 'audio-only' | 'muted' | 'camera-off' | 'local-hidden' | 'unavailable';
type ParticipantCardAction = 'mute' | 'camera' | 'visibility' | 'speak' | 'hand' | 'whiteboard' | 'screen';
type ConfirmationVariant = 'danger' | 'warning' | 'neutral';
type MediaDrawerMode = 'devices' | 'controls';
type WhiteboardMemorySaveState = 'idle' | 'loading' | 'pending' | 'saving' | 'saved' | 'failed';
type LocalWhiteboardUpsertElement = Extract<WhiteboardCommand, { type: 'upsert' }>['element'];
type WhiteboardPermissionOption = {
  value: WhiteboardPermissionLevel;
  label: string;
  description: string;
};

const WHITEBOARD_PERMISSION_OPTIONS: readonly WhiteboardPermissionOption[] = [
  { value: 'draw', label: 'Draw', description: 'Pen strokes only' },
  { value: 'annotate', label: 'Annotate', description: 'Text, shapes, math, and diagrams' },
  { value: 'current_page_edit', label: 'Page edit', description: 'Edit/delete objects on this page' },
  { value: 'view_only', label: 'View only', description: 'No editing tools' }
];
interface CloseLocalProducerOptions {
  strict?: boolean;
}
type ParticipantActionState = Partial<Record<ParticipantCardAction, boolean>>;
type TeacherPreflightMode = 'start' | 'enter';
type TerminalClassSessionStatus = Extract<ClassroomPayload['status'], 'completed' | 'cancelled'>;

interface DeviceSwitchingWebRtc {
  refreshDevices(): Promise<void>;
  devices(): { audioInputs: DeviceOption[]; videoInputs: DeviceOption[] };
  selectedAudioDeviceId?: DeviceIdState;
  selectedVideoDeviceId?: DeviceIdState;
  switchMicrophone?: (deviceId: string | null) => Promise<void> | void;
  switchCamera?: (deviceId: string | null) => Promise<void> | void;
}

interface ConfirmationDialog {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  pendingLabel: string;
  variant: ConfirmationVariant;
  pending: boolean;
}

interface StudentWhiteboardAttempt {
  attemptId: string;
  participantId: string;
  studentName: string;
  permissionLevel: WhiteboardPermissionLevel;
  pageId?: string;
  startedAt: string;
  grantedAt?: string;
  endedAt?: string;
  status: 'active' | 'revoked' | 'kept' | 'cleared' | 'saved';
  baselineKeys: string[];
  elementRefs: WhiteboardElementRef[];
}

@Component({
  selector: 'sfu-teacher-class-session',
  standalone: true,
  imports: [WhiteboardSourceControl, DeviceSetupDialogComponent, ClassroomConnectionTools, RouterLink, SessionChat, SessionMaterials, Whiteboard, MediaStreamDirective],
  templateUrl: './class-session.html',
  styleUrl: './class-session.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherClassSession implements OnInit, OnDestroy {
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly lessonRecorder = inject(LessonRecordingService);
  protected readonly desktopSession = isDesktopSession();
  protected readonly privatePreparation = signal(false);
  protected readonly audioOnlyPreparation = signal(false);
  protected readonly localDraft = signal<{ snapshot: ReturnType<Whiteboard['exportBoardState']>; savedAt: string } | null>(null);
  private readonly recoveryStore = new ClassroomRecoveryStore();
  private localDraftTimer?: ReturnType<typeof setTimeout>;
  private recordingCaptureStarting = false;
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly classSessions = inject(ClassSessionService);
  private readonly socket = inject(SocketService);
  private readonly store = inject(RoomStore);
  protected readonly webrtc = inject(WebRtcService);
  private readonly deviceWebRtc = this.webrtc as WebRtcService & DeviceSwitchingWebRtc;
  private readonly realtimeSocket = this.socket.connect();
  private readonly minimumParticipantHeight = 220;
  private readonly minimumChatHeight = 240;
  private readonly dividerHeight = 10;
  private resizePointerId: number | null = null;
  private resizeHandle: HTMLElement | null = null;
  private joinedRoomId = '';
  private screenProducerId = '';
  private destroyed = false;
  private reconnectingRoom = false;
  private socketWasDisconnected = false;
  private watchedSessionId = '';
  private browserRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private whiteboardAutosaveTimer: ReturnType<typeof setTimeout> | undefined;
  private activityHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private lastUserActivityAt = Date.now();
  private lastActivitySentAt = 0;
  private preflightAudioContext?: AudioContext;
  private preflightAnalyser?: AnalyserNode;
  private preflightMeterFrame = 0;
  private readonly socketDisposers: Array<() => void> = [];
  private readonly localProducerIds = new Set<string>();
  private readonly consumedStudentProducerIds = new Set<string>();
  private readonly pendingStudentProducerIds = new Set<string>();
  private readonly consumerProducerIds = new Map<string, string>();
  private terminalSessionHandled = false;
  private whiteboardCaptureStream: MediaStream | null = null;
  private screenCaptureEpoch = 0;
  private replacingScreenSource = false;
  protected readonly whiteboardSourceChoice = signal<ClassroomWhiteboardSource>('classroom');
  private readonly whiteboardCursorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private confirmationHandler: (() => Promise<void> | void) | null = null;
  private confirmationReturnFocus: HTMLElement | null = null;
  private whiteboardMemoryLoadedSessionId = '';
  private whiteboardMemoryApplying = false;
  private whiteboardMemoryReady = false;
  private whiteboardMemoryRequestId = 0;
  private whiteboardMemoryLoadEvents: WhiteboardCommandEvent[] | null = null;
  private whiteboardSyncTail: Promise<void> = Promise.resolve();
  private whiteboardEditRevision = 0;
  protected readonly whiteboardSaveConflict = signal(false);

  @ViewChild(Whiteboard) private readonly whiteboard?: Whiteboard;
  @ViewChild(SessionMaterials) private readonly materialsPanel?: SessionMaterials;
  @ViewChild('confirmCancelButton') private readonly confirmCancelButton?: ElementRef<HTMLButtonElement>;
  @ViewChild('confirmPrimaryButton') private readonly confirmPrimaryButton?: ElementRef<HTMLButtonElement>;

  protected readonly session = signal<ClassroomPayload | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly mediaNotice = signal('');
  protected readonly mediaError = signal('');
  protected readonly audioPlaybackBlocked = signal(false);
  protected readonly joiningRoom = signal(false);
  protected readonly roomJoined = signal(false);
  protected readonly publishingCamera = signal(false);
  protected readonly cameraPublished = signal(false);
  protected readonly publishingScreen = signal(false);
  protected readonly publishingWhiteboard = signal(false);
  protected readonly whiteboardSharing = signal(false);
  protected readonly stoppingScreen = signal(false);
  protected readonly refreshingDevices = signal(false);
  protected readonly switchingAudioDevice = signal(false);
  protected readonly switchingVideoDevice = signal(false);
  protected readonly preflightOpen = signal(false);
  protected readonly preflightPreparing = signal(false);
  protected readonly preflightActionPending = signal(false);
  protected readonly preflightError = signal('');
  protected readonly preflightSocketReady = signal(false);
  protected readonly microphoneLevel = signal(0);
  protected readonly mutingAllStudents = signal(false);
  protected readonly stoppingAllStudentCameras = signal(false);
  protected readonly lockingClass = signal(false);
  protected readonly downloadingAttendance = signal(false);
  protected readonly recordingActionPending = signal(false);
  protected readonly downloadingRecording = signal(false);
  protected readonly attachingWhiteboardNotes = signal(false);
  protected readonly ending = signal(false);
  protected readonly participants = signal<SessionParticipant[]>([]);
  protected readonly studentCursors = signal<WhiteboardCursor[]>([]);
  protected readonly whiteboardControllerParticipantId = signal('');
  protected readonly whiteboardControllerName = signal('');
  protected readonly whiteboardLocked = signal(false);
  protected readonly whiteboardAttemptSaving = signal(false);
  protected readonly whiteboardAttemptClearing = signal(false);
  protected readonly studentWhiteboardAttempt = signal<StudentWhiteboardAttempt | null>(null);
  protected readonly whiteboardMemoryState = signal<WhiteboardMemoryState | null>(null);
  protected readonly whiteboardMemorySaveState = signal<WhiteboardMemorySaveState>('idle');
  protected readonly whiteboardMemoryNotice = signal('');
  protected readonly whiteboardMemoryBusy = signal(false);
  protected readonly whiteboardVersions = signal<WhiteboardMemoryVersion[]>([]);
  protected readonly previousWhiteboards = signal<PreviousWhiteboardMemorySummary[]>([]);
  protected readonly whiteboardPermissionOptions = WHITEBOARD_PERMISSION_OPTIONS;
  protected readonly selectedWhiteboardPermissionLevel = signal<WhiteboardPermissionLevel>('annotate');
  protected readonly whiteboardControllerPermissionLevel = signal<WhiteboardPermissionLevel>('view_only');
  protected readonly whiteboardControllerPageId = signal('');
  protected readonly chatCollapsed = signal(false);
  protected readonly mediaDrawerOpen = signal(false);
  protected readonly mediaDrawerMode = signal<MediaDrawerMode>('devices');
  protected readonly mediaMenuOpen = signal(false);
  protected readonly confirmationDialog = signal<ConfirmationDialog | null>(null);
  protected readonly chatDisplayName = computed(() => this.auth.user()?.name ?? 'Teacher');
  protected readonly sidebarSplitPercent = signal(50);
  protected readonly resizingSidebar = signal(false);
  protected readonly locallyHiddenParticipantIds = signal<string[]>([]);
  protected readonly pendingParticipantActions = signal<Record<string, ParticipantActionState>>({});
  private readonly localSelectedAudioDeviceId = signal('');
  private readonly localSelectedVideoDeviceId = signal('');
  private readonly lastSharedContentSource = signal<'screen' | 'whiteboard'>('screen');
  protected readonly mediaRecoveryError = this.webrtc.lastMediaError;
  protected readonly sessionLive = computed(() => this.session()?.status === 'live');
  protected readonly liveSettings = computed(() => this.session()?.resolvedLiveSettings ?? null);
  protected readonly whiteboardSharingEnabled = computed(() => this.liveSettings()?.whiteboard.whiteboardSharingEnabled !== false);
  protected readonly studentWhiteboardControlEnabled = computed(() => this.liveSettings()?.whiteboard.studentWhiteboardControlEnabled !== false);
  protected readonly materialsEnabled = computed(() => this.liveSettings()?.materials.materialsEnabled !== false);
  protected readonly teacherCanUploadMaterials = computed(() => this.materialsEnabled() && this.liveSettings()?.materials.teacherCanUploadMaterials !== false);
  protected readonly recordingEnabled = computed(() => this.liveSettings()?.recording.recordingEnabled !== false);
  protected readonly teacherRecordingControlEnabled = computed(
    () => this.recordingEnabled() && this.liveSettings()?.recording.teacherManualRecordingControlEnabled !== false
  );
  protected readonly handRaiseEnabled = computed(() => this.liveSettings()?.speaking.handRaiseEnabled !== false);
  protected readonly networkWarning = computed(() => {
    const policy = this.liveSettings()?.bandwidthPolicy;
    if (policy?.showNetworkWarnings === false || this.webrtc.networkScore() > 2) {
      return '';
    }
    return policy?.preferAudioOnPoorNetwork
      ? 'Network is weak. Prefer audio-first teaching until quality improves.'
      : 'Network is weak. Media quality may be reduced.';
  });
  protected readonly roomLocked = computed(() => Boolean(this.store.room()?.settings.locked));
  protected readonly studentControlTargets = computed(() => this.participants().filter((participant) => participant.canModerate));
  protected readonly whiteboardControlActive = computed(() => Boolean(this.whiteboardControllerParticipantId()));
  protected readonly studentWhiteboardAttemptCount = computed(() => this.studentWhiteboardAttempt()?.elementRefs.length ?? 0);
  protected readonly studentWhiteboardAttemptHasChanges = computed(() => this.studentWhiteboardAttemptCount() > 0);
  protected readonly whiteboardMemoryStatusLabel = computed(() => {
    switch (this.whiteboardMemorySaveState()) {
      case 'loading':
        return 'Loading board';
      case 'pending':
        return 'Autosave pending';
      case 'saving':
        return 'Saving board';
      case 'saved':
        return 'Board saved';
      case 'failed':
        return 'Save failed';
      case 'idle':
        return this.whiteboardMemoryState() ? 'Board memory ready' : 'No saved board yet';
    }
  });
  protected readonly whiteboardMemorySummaryLabel = computed(() => {
    const summary = this.whiteboardMemoryState()?.summary;
    if (!summary) {
      return 'This session will autosave as you teach.';
    }
    return `${summary.pageCount} page${summary.pageCount === 1 ? '' : 's'} · ${summary.elementCount} item${summary.elementCount === 1 ? '' : 's'}`;
  });
  protected readonly selectedWhiteboardPermissionLabel = computed(() => this.whiteboardPermissionLabel(this.selectedWhiteboardPermissionLevel()));
  protected readonly whiteboardControllerPermissionLabel = computed(() => this.whiteboardPermissionLabel(this.whiteboardControllerPermissionLevel()));
  protected readonly raisedHandParticipants = computed(() =>
    this.studentControlTargets()
      .filter((participant) => participant.handRaised)
      .sort((left, right) => (left.handRaisedAt ?? '').localeCompare(right.handRaisedAt ?? ''))
  );
  protected readonly raisedHandCount = computed(() => this.raisedHandParticipants().length);
  protected readonly classControlsBusy = computed(
    () =>
      this.mutingAllStudents() ||
      this.stoppingAllStudentCameras() ||
      this.lockingClass() ||
      this.downloadingAttendance() ||
      this.recordingActionPending() ||
      this.downloadingRecording() ||
      this.attachingWhiteboardNotes() ||
      this.ending()
  );
  protected readonly activeRecording = computed(() => this.session()?.activeRecording ?? null);
  protected readonly latestRecording = computed(() => this.session()?.latestRecording ?? null);
  protected readonly recordingActive = computed(() => this.isActiveRecording(this.activeRecording()));
  protected readonly recordingControlLabel = computed(() => {
    if (this.recordingActionPending()) return this.recordingActive() ? 'Stopping...' : 'Starting...';
    return this.recordingActive() ? 'Stop Recording' : 'Start Recording';
  });
  protected readonly recordingControlTitle = computed(() => {
    if (!this.recordingEnabled() && !this.recordingActive()) return 'Recording is disabled for this class';
    if (!this.teacherRecordingControlEnabled() && !this.recordingActive()) return 'Teacher recording control is disabled for this class';
    return this.recordingActive() ? 'Stop lesson recording' : 'Start lesson recording';
  });
  protected readonly recordingStatusLabel = computed(() => {
    const active = this.activeRecording();
    if (active?.status === 'stopping') return 'Recording stopping';
    if (active?.status === 'starting') return 'Recording starting';
    if (active?.status === 'recording') return 'Recording live';
    const latest = this.latestRecording();
    if (latest?.status === 'stopped') return 'Recording ready';
    if (latest?.status === 'failed') return 'Recording failed';
    return 'Not recording';
  });
  protected readonly audioInputDevices = computed(() => this.webrtc.devices().audioInputs);
  protected readonly videoInputDevices = computed(() => this.webrtc.devices().videoInputs);
  protected readonly selectedAudioDeviceId = computed(() => this.readSelectedDeviceId('audio'));
  protected readonly selectedVideoDeviceId = computed(() => this.readSelectedDeviceId('video'));
  protected readonly preflightPreviewStream = this.webrtc.localStream;
  protected readonly preflightMode = computed<TeacherPreflightMode>(() => (this.sessionLive() ? 'enter' : 'start'));
  protected readonly preflightTitle = computed(() => (this.preflightMode() === 'start' ? 'Start live class' : 'Enter live class'));
  protected readonly preflightPrimaryLabel = computed(() => {
    if (this.preflightActionPending()) {
      return this.preflightMode() === 'start' ? 'Starting...' : 'Entering...';
    }
    return this.preflightMode() === 'start' ? 'Start Live Class' : 'Enter Live Class';
  });
  protected readonly cameraPreviewReady = computed(() => Boolean(this.preflightPreviewStream()?.getVideoTracks().some((track) => track.readyState === 'live')));
  protected readonly microphonePreviewReady = computed(() => Boolean(this.preflightPreviewStream()?.getAudioTracks().some((track) => track.readyState === 'live')));
  protected readonly cameraOptionalReady = computed(() => this.audioOnlyPreparation() || this.cameraPreviewReady() || this.videoInputDevices().length === 0);
  protected readonly microphoneOptionalReady = computed(() => this.microphonePreviewReady() || this.audioInputDevices().length === 0);
  protected readonly preflightCanConfirm = computed(
    () =>
      Boolean(this.session()) &&
      this.preflightOpen() &&
      !this.preflightPreparing() &&
      !this.preflightActionPending() &&
      this.preflightSocketReady() &&
      this.cameraOptionalReady() &&
      this.microphoneOptionalReady()
  );
  protected readonly socketReadinessLabel = computed(() => (this.preflightSocketReady() ? 'Class connection ready' : 'Connecting to class'));
  protected readonly cameraReadinessLabel = computed(() => {
    if (this.cameraPreviewReady()) return 'Camera ready';
    return this.videoInputDevices().length ? 'Camera off or permission needed' : 'No camera detected';
  });
  protected readonly microphoneReadinessLabel = computed(() => {
    if (this.microphonePreviewReady()) return 'Microphone ready';
    return this.audioInputDevices().length ? 'Microphone off or permission needed' : 'No microphone detected';
  });
  protected readonly deviceReadinessLabel = computed(() => {
    if (this.audioInputDevices().length && this.videoInputDevices().length) return 'Devices detected';
    if (this.preflightPreparing()) return 'Checking devices';
    if (this.audioInputDevices().length || this.videoInputDevices().length) return 'Partial device setup';
    return 'Device list pending';
  });
  protected readonly mediaBusy = computed(() =>
    this.joiningRoom() ||
    this.publishingCamera() ||
    this.publishingScreen() ||
    this.publishingWhiteboard() ||
    this.stoppingScreen() ||
    this.refreshingDevices() ||
    this.switchingAudioDevice() ||
    this.switchingVideoDevice()
  );
  protected readonly screenSharing = computed(() => Boolean(this.webrtc.screenStream()) && !this.whiteboardSharing());
  protected readonly presentedDeviceProducer = computed(() =>
    (this.store.room()?.producers ?? []).filter((producer) => producer.kind === 'screen' && producer.source !== 'whiteboard' && producer.status === 'live')
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
  );
  protected readonly presentedDeviceStream = computed(() => {
    const producer = this.presentedDeviceProducer();
    if (!producer) return null;
    if (producer.participantId === this.store.localParticipantId()) return this.webrtc.screenStream();
    return this.webrtc.remoteStreams().find((remote) => remote.producerId === producer.id)?.stream ?? null;
  });
  protected readonly devicePresenterName = computed(() => {
    const producer = this.presentedDeviceProducer();
    if (!producer) return '';
    return producer.participantId === this.store.localParticipantId() ? 'You' : this.store.room()?.participants.find((participant) => participant.id === producer.participantId)?.displayName ?? 'Student';
  });
  protected readonly whiteboardSource = computed<ClassroomWhiteboardSource>(() => this.presentedDeviceProducer() ? 'device' : this.whiteboardSourceChoice());

  protected readonly studentAudioStreams = computed(() =>
    this.webrtc.remoteStreams()
      .filter((remote) => remote.kind === 'audio' && this.isStudentParticipantId(remote.participantId) && !this.isParticipantMediaHidden(remote.participantId))
      .map((remote) => ({ producerId: remote.producerId, stream: remote.stream }))
  );
  protected readonly chatThreadParticipants = computed(() =>
    this.participants()
      .filter((participant) => participant.isStudent)
      .map((participant) => ({
        id: participant.id,
        name: participant.name,
        initials: participant.initials,
        role: participant.role
      }))
  );
  protected readonly mediaStatusLabel = computed(() => {
    if (this.joiningRoom()) return 'Joining room';
    if (this.publishingCamera()) return 'Publishing camera';
    if (this.publishingScreen()) return 'Starting screen share';
    if (this.publishingWhiteboard()) return 'Starting whiteboard share';
    if (this.stoppingScreen()) return this.whiteboardSharing() ? 'Stopping whiteboard share' : 'Stopping screen share';
    if (this.switchingAudioDevice()) return 'Switching microphone';
    if (this.switchingVideoDevice()) return 'Switching camera';
    if (this.refreshingDevices()) return 'Refreshing devices';
    if (this.whiteboardSharing()) return 'Whiteboard sharing';
    if (this.screenSharing()) return 'Screen sharing';
    if (this.mediaError()) return 'Media attention';
    if (this.cameraPublished()) return this.audioOnlyPreparation() ? 'Microphone live' : 'Camera live';
    return 'Media idle';
  });
  protected readonly mediaDrawerTitle = computed(() => (this.mediaDrawerMode() === 'devices' ? 'Device settings' : 'Class status'));
  protected readonly activeShareLabel = computed(() => (this.whiteboardSharing() ? 'Whiteboard' : this.screenSharing() ? 'Screen' : 'None'));
  protected readonly selectedAudioDeviceLabel = computed(() =>
    this.selectedDeviceLabel(this.audioInputDevices(), this.selectedAudioDeviceId(), 'System default microphone')
  );
  protected readonly selectedVideoDeviceLabel = computed(() =>
    this.selectedDeviceLabel(this.videoInputDevices(), this.selectedVideoDeviceId(), 'System default camera')
  );
  protected readonly classControlSummary = computed(() => {
    const students = this.studentControlTargets();
    return {
      students: students.length,
      liveCameras: students.filter((participant) => this.hasLiveStudentCamera(participant.id)).length,
      hiddenMedia: students.filter((participant) => this.isParticipantMediaHidden(participant.id)).length,
      raisedHands: this.raisedHandCount()
    };
  });
  protected readonly sidebarRows = computed(() =>
    this.chatCollapsed()
      ? 'minmax(0, 1fr) auto'
      : `minmax(${this.minimumParticipantHeight}px, ${this.sidebarSplitPercent()}fr) ${this.dividerHeight}px minmax(${this.minimumChatHeight}px, ${100 - this.sidebarSplitPercent()}fr)`
  );

  protected toggleMediaDrawer(): void {
    this.mediaMenuOpen.set(false);
    this.mediaDrawerMode.set('controls');
    this.mediaDrawerOpen.update((open) => !open);
  }

  protected openMediaDrawer(mode: MediaDrawerMode = 'devices'): void {
    this.mediaMenuOpen.set(false);
    this.mediaDrawerMode.set(mode);
    this.mediaDrawerOpen.set(true);
  }

  protected closeMediaDrawer(): void {
    this.mediaDrawerOpen.set(false);
  }

  protected toggleMediaMenu(): void {
    this.mediaDrawerOpen.set(false);
    this.mediaMenuOpen.update((open) => !open);
  }

  protected closeMediaMenu(): void {
    this.mediaMenuOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  protected closeTeacherOverlays(): void {
    if (this.confirmationDialog()) {
      this.cancelConfirmation();
      return;
    }
    this.closeMediaMenu();
    this.closeMediaDrawer();
  }

  @HostListener('document:keydown.enter', ['$event'])
  protected confirmDialogOnEnter(event: Event): void {
    const dialog = this.confirmationDialog();
    if (!dialog || dialog.pending || this.isEditableKeyboardTarget(event.target)) {
      return;
    }
    event.preventDefault();
    void this.confirmDialogAction();
  }

  ngOnInit(): void {
    this.preflightSocketReady.set(this.realtimeSocket.connected);
    this.bindSocketEvents();
    this.bindBrowserRecoveryEvents();
    this.loadSession();
  }

  ngOnDestroy(): void {
    void this.persistLocalDraft();
    if (this.localDraftTimer) clearTimeout(this.localDraftTimer);
    void this.lessonRecorder.stop().catch(() => undefined);
    void window.classroomDesktop?.setClassActive(false);
    this.destroyed = true;
    this.clearWhiteboardAutosaveTimer();
    void this.saveWhiteboardMemory('autosave', false).catch(() => null);
    this.unwatchSession();
    this.clearBrowserRecoveryTimer();
    this.stopActivityHeartbeat();
    void this.stopPreflightPreview();
    for (const dispose of this.socketDisposers.splice(0)) {
      dispose();
    }
    void this.leaveCurrentRoom();
  }

  protected async muteStudentMicrophone(participantId: string): Promise<void> {
    const roomId = this.currentRoomId();
    if (!this.canModerateParticipant(participantId) || !roomId || this.isParticipantActionPending(participantId, 'mute') || this.isParticipantMicTeacherDisabled(participantId)) {
      return;
    }

    this.setParticipantActionPending(participantId, 'mute', true);
    this.mediaError.set('');
    try {
      const event = await this.socket.emitAck('student:mute-mic', { roomId, participantId });
      this.applyStudentModerationResult(event);
      this.mediaNotice.set('Student microphone muted.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to mute student microphone.');
    } finally {
      this.setParticipantActionPending(participantId, 'mute', false);
    }
  }

  protected async unmuteStudentMicrophone(participantId: string): Promise<void> {
    const roomId = this.currentRoomId();
    if (!this.canModerateParticipant(participantId) || !roomId || this.isParticipantActionPending(participantId, 'mute') || !this.isParticipantMicTeacherDisabled(participantId)) {
      return;
    }

    this.setParticipantActionPending(participantId, 'mute', true);
    this.mediaError.set('');
    try {
      const event = await this.socket.emitAck('student:unmute-mic', { roomId, participantId });
      this.applyStudentModerationResult(event);
      this.mediaNotice.set('Student microphone allowed.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to allow student microphone.');
    } finally {
      this.setParticipantActionPending(participantId, 'mute', false);
    }
  }

  protected async allowStudentToSpeak(participantId: string): Promise<void> {
    const roomId = this.currentRoomId();
    if (!this.canModerateParticipant(participantId) || !roomId || this.isParticipantActionPending(participantId, 'speak')) {
      return;
    }

    this.setParticipantActionPending(participantId, 'speak', true);
    this.mediaError.set('');
    try {
      const event = await this.socket.emitAck('class:allow-speak', { roomId, participantId });
      this.applyStudentSpeakResult(event);
      this.mediaNotice.set('Student can speak now.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to allow student to speak.');
    } finally {
      this.setParticipantActionPending(participantId, 'speak', false);
    }
  }

  protected async revokeStudentSpeaking(participantId: string): Promise<void> {
    const roomId = this.currentRoomId();
    if (!this.canModerateParticipant(participantId) || !roomId || this.isParticipantActionPending(participantId, 'speak')) {
      return;
    }

    this.setParticipantActionPending(participantId, 'speak', true);
    this.mediaError.set('');
    try {
      const event = await this.socket.emitAck('class:revoke-speak', { roomId, participantId });
      this.applyStudentSpeakResult(event);
      this.mediaNotice.set('Student speaking permission revoked.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to revoke speaking permission.');
    } finally {
      this.setParticipantActionPending(participantId, 'speak', false);
    }
  }

  protected async lowerRaisedHand(participantId: string): Promise<void> {
    const roomId = this.currentRoomId();
    if (!this.canModerateParticipant(participantId) || !roomId || this.isParticipantActionPending(participantId, 'hand')) {
      return;
    }

    this.setParticipantActionPending(participantId, 'hand', true);
    this.mediaError.set('');
    try {
      const patch = await this.socket.emitAck('class:lower-hand', { roomId, participantId });
      this.applyParticipantPatch(participantId, patch);
      this.mediaNotice.set('Raised hand cleared.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to clear raised hand.');
    } finally {
      this.setParticipantActionPending(participantId, 'hand', false);
    }
  }

  protected hasWhiteboardControl(participantId: string): boolean {
    return this.whiteboardControllerParticipantId() === participantId;
  }

  protected setWhiteboardPermissionLevel(event: Event): void {
    const selectElement = event.target as HTMLSelectElement;
    const nextLevel = selectElement.value as WhiteboardPermissionLevel;
    if (!WHITEBOARD_PERMISSION_OPTIONS.some((option) => option.value === nextLevel)) {
      return;
    }
    this.selectedWhiteboardPermissionLevel.set(nextLevel);
  }

  protected async grantWhiteboardControl(participantId: string): Promise<void> {
    const roomId = this.currentRoomId();
    if (!this.studentWhiteboardControlEnabled()) {
      this.mediaError.set('Student whiteboard control is disabled for this class.');
      return;
    }
    if (!this.canModerateParticipant(participantId) || !roomId || this.isParticipantActionPending(participantId, 'whiteboard')) {
      return;
    }

    this.setParticipantActionPending(participantId, 'whiteboard', true);
    this.mediaError.set('');
    try {
      await this.whiteboardSyncTail;
      if (this.whiteboardSaveConflict()) throw new Error('Reload the saved whiteboard before granting control.');
      const pageId = this.whiteboard?.currentPageId();
      const permissionLevel = this.selectedWhiteboardPermissionLevel();
      const event = await this.socket.emitAck('whiteboard:grant-control', {
        roomId,
        participantId,
        permissionLevel,
        ...(pageId ? { pageId } : {})
      });
      this.applyWhiteboardControlEvent(event);
      this.mediaNotice.set(`Whiteboard ${this.whiteboardPermissionLabel(event.permissionLevel ?? permissionLevel)} allowed for ${event.displayName ?? 'student'}.`);
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to allow whiteboard control.');
    } finally {
      this.setParticipantActionPending(participantId, 'whiteboard', false);
    }
  }

  protected async revokeWhiteboardControl(participantId = this.whiteboardControllerParticipantId()): Promise<void> {
    const roomId = this.currentRoomId();
    if (!participantId || !roomId || this.isParticipantActionPending(participantId, 'whiteboard')) {
      return;
    }

    this.setParticipantActionPending(participantId, 'whiteboard', true);
    this.mediaError.set('');
    try {
      const event = await this.socket.emitAck('whiteboard:revoke-control', { roomId, participantId });
      this.applyWhiteboardControlEvent(event);
      this.mediaNotice.set('Whiteboard control revoked.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to revoke whiteboard control.');
    } finally {
      this.setParticipantActionPending(participantId, 'whiteboard', false);
    }
  }

  protected async toggleWhiteboardLock(): Promise<void> {
    const roomId = this.currentRoomId();
    if (!roomId || !this.sessionLive() || !this.roomJoined() || this.lockingClass()) {
      return;
    }

    const nextLocked = !this.whiteboardLocked();
    this.lockingClass.set(true);
    this.mediaError.set('');
    try {
      const event = await this.socket.emitAck('whiteboard:set-lock', { roomId, locked: nextLocked });
      this.applyWhiteboardLockEvent(event);
      this.mediaNotice.set(nextLocked ? 'Whiteboard locked for student editing.' : 'Whiteboard unlocked.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : nextLocked ? 'Unable to lock whiteboard.' : 'Unable to unlock whiteboard.');
    } finally {
      this.lockingClass.set(false);
    }
  }

  protected keepStudentWhiteboardAttempt(): void {
    const attempt = this.studentWhiteboardAttempt();
    if (!attempt) {
      return;
    }
    this.studentWhiteboardAttempt.set({
      ...attempt,
      status: 'kept',
      endedAt: attempt.endedAt ?? new Date().toISOString(),
      elementRefs: []
    });
    this.mediaNotice.set('Student whiteboard changes kept on the board.');
  }

  protected async clearStudentWhiteboardAttempt(): Promise<void> {
    const attempt = this.studentWhiteboardAttempt();
    if (!attempt || this.whiteboardAttemptClearing()) {
      return;
    }
    if (!attempt.elementRefs.length) {
      this.mediaNotice.set('No student-authored whiteboard elements are available to clear.');
      return;
    }
    this.whiteboardAttemptClearing.set(true);
    try {
      const removed = this.whiteboard?.removeElementsByRefs(attempt.elementRefs) ?? 0;
      this.studentWhiteboardAttempt.set({
        ...attempt,
        status: 'cleared',
        endedAt: attempt.endedAt ?? new Date().toISOString(),
        elementRefs: []
      });
      this.mediaNotice.set(removed ? `Cleared ${removed} student whiteboard change${removed === 1 ? '' : 's'}.` : 'No matching student changes remained on the board.');
    } finally {
      this.whiteboardAttemptClearing.set(false);
    }
  }

  protected async saveStudentWhiteboardAttempt(clearAfterSave = false): Promise<void> {
    const attempt = this.studentWhiteboardAttempt();
    const session = this.session();
    if (!attempt || !session || this.whiteboardAttemptSaving() || this.attachingWhiteboardNotes()) {
      return;
    }
    this.whiteboardAttemptSaving.set(true);
    try {
      const safeName = this.safeFileSegment(attempt.studentName);
      const saved = await this.uploadWhiteboardNotes(
        `class-session-${session.sessionNumber}-${safeName}-whiteboard-attempt`,
        `${attempt.studentName} whiteboard attempt saved and shared with students.`
      );
      if (!saved) {
        return;
      }
      this.studentWhiteboardAttempt.set({
        ...attempt,
        status: 'saved',
        endedAt: attempt.endedAt ?? new Date().toISOString()
      });
      if (clearAfterSave) {
        await this.clearStudentWhiteboardAttempt();
      }
    } finally {
      this.whiteboardAttemptSaving.set(false);
    }
  }

  protected handleTeacherWhiteboardCommand(command: WhiteboardCommand): void {
    if (this.privatePreparation() && !this.sessionLive()) { this.scheduleWhiteboardAutosave(); return; }
    this.whiteboardEditRevision += 1;
    this.scheduleWhiteboardAutosave();
    if (this.whiteboardMemoryApplying) return;
    const roomId = this.currentRoomId();
    if (!roomId || !this.sessionLive() || !this.roomJoined()) {
      this.whiteboardSaveConflict.set(true);
      this.whiteboardMemorySaveState.set('failed');
      this.whiteboardMemoryNotice.set('A board change was made while disconnected. Your local board is preserved. Download a backup before reloading the saved board.');
      return;
    }
    const operationId = this.createWhiteboardOperationId();
    const send = this.whiteboardSyncTail.then(async () => {
      const request = { roomId, operationId, command: this.toWireWhiteboardCommand(command) };
      const event = await this.socket.emitAck('whiteboard:command', request).catch(() => this.socket.emitAck('whiteboard:command', request));
      if (this.whiteboardMemoryLoadEvents) this.whiteboardMemoryLoadEvents.push(event);
      else this.updateWhiteboardRevision(event);
    });
    this.whiteboardSyncTail = send.catch((error) => {
      this.whiteboardSaveConflict.set(true);
      this.whiteboardMemorySaveState.set('failed');
      this.whiteboardMemoryNotice.set('A board change could not be synchronized. Your local board is preserved. Download a backup before reloading the saved board.');
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to sync whiteboard command.');
    });
  }

  protected handleTeacherWhiteboardStateChanged(): void {
    this.whiteboardEditRevision += 1;
    this.scheduleWhiteboardAutosave();
  }

  protected handleTeacherWhiteboardCursor(cursor: WhiteboardCursor): void {
    const roomId = this.currentRoomId();
    if (!roomId || !this.sessionLive() || !this.roomJoined() || !this.whiteboardControlActive()) {
      return;
    }
    void this.socket
      .emitAck('whiteboard:cursor', {
        roomId,
        cursor: {
          color: cursor.color,
          position: cursor.position
        }
      })
      .catch(() => undefined);
  }

  protected async stopStudentCamera(participantId: string): Promise<void> {
    const roomId = this.currentRoomId();
    if (!this.canModerateParticipant(participantId) || !roomId || this.isParticipantActionPending(participantId, 'camera') || this.isParticipantCameraTeacherDisabled(participantId)) {
      return;
    }

    this.setParticipantActionPending(participantId, 'camera', true);
    this.mediaError.set('');
    try {
      const event = await this.socket.emitAck('student:stop-camera', { roomId, participantId });
      this.applyStudentModerationResult(event);
      this.mediaNotice.set('Student camera stopped.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to stop student camera.');
    } finally {
      this.setParticipantActionPending(participantId, 'camera', false);
    }
  }

  protected async restoreStudentCamera(participantId: string): Promise<void> {
    const roomId = this.currentRoomId();
    if (!this.canModerateParticipant(participantId) || !roomId || this.isParticipantActionPending(participantId, 'camera') || !this.isParticipantCameraTeacherDisabled(participantId)) {
      return;
    }

    this.setParticipantActionPending(participantId, 'camera', true);
    this.mediaError.set('');
    try {
      const event = await this.socket.emitAck('student:restore-camera', { roomId, participantId });
      this.applyStudentModerationResult(event);
      this.mediaNotice.set('Student camera allowed.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to allow student camera.');
    } finally {
      this.setParticipantActionPending(participantId, 'camera', false);
    }
  }

  protected async toggleStudentMediaVisibility(participantId: string): Promise<void> {
    if (!this.canModerateParticipant(participantId) || this.isParticipantActionPending(participantId, 'visibility')) {
      return;
    }

    this.setParticipantActionPending(participantId, 'visibility', true);
    this.mediaError.set('');
    try {
      if (this.isParticipantMediaHidden(participantId)) {
        this.setParticipantMediaHidden(participantId, false);
        await this.consumeStudentParticipantMedia(participantId);
        this.mediaNotice.set('Student media shown locally.');
      } else {
        this.setParticipantMediaHidden(participantId, true);
        this.cleanupStudentParticipantMedia(participantId, true);
        this.mediaNotice.set('Student media hidden locally.');
      }
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to update local student media.');
    } finally {
      this.setParticipantActionPending(participantId, 'visibility', false);
    }
  }

  protected async selectWhiteboardSource(source: ClassroomWhiteboardSource): Promise<void> {
    if (source === 'device') { this.whiteboardSourceChoice.set('device'); return; }
    await this.useClassroomWhiteboard();
  }

  protected async useClassroomWhiteboard(): Promise<void> {
    if (this.mediaBusy()) return;
    const presenter = this.presentedDeviceProducer();
    if (presenter && presenter.participantId !== this.store.localParticipantId()) {
      if (!await this.setDeviceSharingPermission(presenter.participantId, false)) return;
    }
    if (this.roomJoined() && this.whiteboardSharingEnabled() && !this.whiteboardSharing()) {
      await this.shareWhiteboard();
    } else if (this.screenSharing()) {
      await this.stopScreenShare();
    }
    this.whiteboardSourceChoice.set(this.screenSharing() ? 'device' : 'classroom');
  }

  protected hasDeviceSharingPermission(participantId: string): boolean {
    return Boolean(this.store.room()?.participants.find((participant) => participant.id === participantId)?.permissions.canShareScreen);
  }

  protected deviceSharingRequested(participantId: string): boolean {
    return Boolean(this.store.room()?.participants.find((participant) => participant.id === participantId)?.screenShareRequested);
  }

  protected async setDeviceSharingPermission(participantId: string, allowed: boolean): Promise<boolean> {
    const roomId = this.currentRoomId();
    if (!roomId || !this.roomJoined() || !this.canModerateParticipant(participantId) || this.isParticipantActionPending(participantId, 'screen')) return false;
    this.setParticipantActionPending(participantId, 'screen', true);
    this.mediaError.set('');
    try {
      if (allowed) {
        const others = (this.store.room()?.participants ?? []).filter((participant) => participant.id !== participantId && this.isStudentParticipantId(participant.id) && participant.permissions.canShareScreen);
        for (const participant of others) {
          if (!await this.setDeviceSharingPermission(participant.id, false)) throw new Error('Could not end the previous student presentation. Try again.');
        }
        // An explicit teacher handoff returns to the saved board while the student chooses a window.
        if (this.screenSharing()) {
          if (this.whiteboardSharingEnabled()) await this.shareWhiteboard();
          else await this.stopScreenShare();
          if (this.screenSharing()) throw new Error('Stop your device sharing before allowing a student to present.');
        }
      }
      await this.socket.emitAck('permission:update', { roomId, participantId, permissions: { canShareScreen: allowed } });
      const participant = this.store.room()?.participants.find((item) => item.id === participantId);
      if (participant) this.store.patchParticipant(participantId, { permissions: { ...participant.permissions, canShareScreen: allowed }, screenShareRequested: false, screenShareRequestedAt: undefined });
      this.mediaNotice.set(allowed ? 'Student may choose a device whiteboard to share.' : 'Device sharing permission removed.');
      return true;
    } catch (error) { this.mediaError.set(error instanceof Error ? error.message : 'Unable to update device sharing permission.'); return false; }
    finally { this.setParticipantActionPending(participantId, 'screen', false); }
  }

  protected async toggleScreenShare(): Promise<void> {
    if (this.screenSharing()) { await this.useClassroomWhiteboard(); return; }
    await this.shareScreen();
  }

  protected async toggleWhiteboardShare(): Promise<void> {
    if (!this.whiteboardSharingEnabled()) { this.mediaError.set('Whiteboard sharing is disabled for this class.'); return; }
    if (this.whiteboardSharing() && !this.presentedDeviceProducer()) { await this.stopScreenShare(); return; }
    await this.useClassroomWhiteboard();
  }

  protected async refreshDevices(): Promise<void> {
    await this.refreshMediaDevices();
  }

  protected async runTeacherMediaRecovery(): Promise<void> {
    const recoveryError = this.mediaRecoveryError();
    if (this.audioPlaybackBlocked() || recoveryError?.code === 'autoplay_blocked') {
      await this.enableStudentAudio();
      return;
    }
    if (this.mediaBusy()) {
      return;
    }
    if (recoveryError?.kind === 'screen') {
      if (this.lastSharedContentSource() === 'whiteboard') {
        await this.shareWhiteboard();
      } else {
        await this.shareScreen();
      }
      return;
    }
    if (recoveryError?.kind === 'consumer') {
      this.mediaError.set('');
      await this.consumeAvailableStudentProducers();
      return;
    }
    if (recoveryError?.operation === 'refresh' || recoveryError?.code === 'device_unavailable') {
      await this.refreshMediaDevices();
      return;
    }
    const payload = this.session();
    if (payload?.roomId && this.roomJoined()) {
      await this.publishCamera(payload.roomId);
      return;
    }
    await this.refreshMediaDevices();
  }

  protected handleStudentAudioPlaybackBlocked(error: unknown): void {
    this.audioPlaybackBlocked.set(true);
    const mediaError = this.webrtc.recordAutoplayBlocked(error);
    this.mediaError.set(mediaError.message);
  }

  protected async enableStudentAudio(): Promise<void> {
    const audioElements = Array.from(document.querySelectorAll<HTMLAudioElement>('.student-audio-streams audio'));
    if (!audioElements.length) {
      this.audioPlaybackBlocked.set(false);
      this.webrtc.clearMediaIssue('audio');
      return;
    }
    try {
      await Promise.all(audioElements.map((audio) => audio.play()));
      this.audioPlaybackBlocked.set(false);
      this.webrtc.clearMediaIssue('audio');
      if (this.mediaRecoveryError()?.code === 'autoplay_blocked') {
        this.mediaError.set('');
      }
      this.mediaNotice.set('Student audio enabled.');
    } catch (error) {
      const mediaError = this.webrtc.recordAutoplayBlocked(error);
      this.mediaError.set(mediaError.message);
    }
  }

  protected async switchMicrophone(deviceId: string): Promise<void> {
    const nextDeviceId = deviceId.trim();
    if (nextDeviceId === this.selectedAudioDeviceId() || this.switchingAudioDevice()) {
      return;
    }

    this.switchingAudioDevice.set(true);
    this.mediaError.set('');
    try {
      if (typeof this.deviceWebRtc.switchMicrophone !== 'function') {
        throw new Error('Microphone switching is waiting on WebRtcService support.');
      }
      await this.deviceWebRtc.switchMicrophone(nextDeviceId);
      this.setSelectedDeviceId('audio', nextDeviceId);
      this.mediaNotice.set('Microphone switched.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to switch microphone.');
    } finally {
      this.switchingAudioDevice.set(false);
    }
  }

  protected async switchCamera(deviceId: string): Promise<void> {
    const nextDeviceId = deviceId.trim();
    if ((nextDeviceId === this.selectedVideoDeviceId() && !this.audioOnlyPreparation()) || this.switchingVideoDevice()) {
      return;
    }

    this.switchingVideoDevice.set(true);
    this.mediaError.set('');
    try {
      if (typeof this.deviceWebRtc.switchCamera !== 'function') {
        throw new Error('Camera switching is waiting on WebRtcService support.');
      }
      await this.deviceWebRtc.switchCamera(nextDeviceId);
      if (this.audioOnlyPreparation() && this.joinedRoomId && this.webrtc.localStream()) {
        const transport = await this.webrtc.preparePeer(this.joinedRoomId);
        const producer = await this.webrtc.publish(this.joinedRoomId, transport, 'video', this.webrtc.localStream()!);
        this.addLocalProducer(producer);
        this.audioOnlyPreparation.set(false);
      }
      this.setSelectedDeviceId('video', nextDeviceId);
      this.mediaNotice.set('Camera switched.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to switch camera.');
    } finally {
      this.switchingVideoDevice.set(false);
    }
  }

  protected leaveClassroom(): void {
    this.openConfirmation({ title: 'Leave this class?', message: 'The class stays live for everyone else. Any recording on this device will stop and upload.', confirmLabel: 'Leave class', cancelLabel: 'Stay', pendingLabel: 'Leaving…', variant: 'neutral' }, async () => {
      await this.lessonRecorder.stop().catch(() => undefined);
      await this.saveWhiteboardMemory('autosave', false).catch(() => null);
      await this.leaveCurrentRoom();
      await this.router.navigate(this.desktopSession ? ['/desktop/upcoming'] : ['/teacher/dashboard']);
    });
  }

  protected endSession(): void {
    const session = this.session();
    if (!session || this.ending()) {
      return;
    }
    this.openConfirmation(
      {
        title: 'End class for everyone?',
        message: 'This manually ends the live session, stops class media, closes the room, and moves students to the ended state.',
        confirmLabel: 'End session',
        cancelLabel: 'Keep class live',
        pendingLabel: 'Ending...',
        variant: 'danger'
      },
      () => this.executeEndSession()
    );
  }

  private executeEndSession(): Promise<void> {
    const session = this.session();
    if (!session || this.ending()) {
      return Promise.resolve();
    }
    this.ending.set(true);
    this.error.set('');
    this.clearWhiteboardAutosaveTimer();
    return this.lessonRecorder.stop().catch(() => undefined).then(() => this.saveWhiteboardMemory('session-end', true))
      .then((state) => { if (!state) this.downloadLocalWhiteboardBackup(); return state; })
      .catch(() => { this.downloadLocalWhiteboardBackup(); return null; })
      .then(
        () =>
          new Promise<void>((resolve) => {
      this.classSessions.endSession(session.sessionId).subscribe({
        next: (payload) => {
          void (async () => {
            try {
              this.applyPayload(payload, { leaveOnTerminal: false });
              await this.leaveCurrentRoom();
              await this.router.navigate(this.desktopSession ? ['/desktop/upcoming'] : ['/teacher/dashboard/batches', payload.batchId]);
            } catch (error) {
              this.error.set(error instanceof Error ? error.message : 'The session ended, but the classroom cleanup did not finish.');
              this.ending.set(false);
            } finally {
              resolve();
            }
          })();
        },
        error: (error) => {
          this.error.set(this.classSessions.errorMessage(error));
          this.ending.set(false);
          resolve();
        }
      });
          })
      );
  }

  protected cancelConfirmation(): void {
    const dialog = this.confirmationDialog();
    if (dialog?.pending) {
      return;
    }
    this.confirmationHandler = null;
    this.confirmationDialog.set(null);
    this.restoreConfirmationFocus();
  }

  protected async confirmDialogAction(): Promise<void> {
    const dialog = this.confirmationDialog();
    const handler = this.confirmationHandler;
    if (!dialog || dialog.pending || !handler) {
      return;
    }
    this.confirmationDialog.set({ ...dialog, pending: true });
    try {
      await handler();
      this.confirmationHandler = null;
      this.confirmationDialog.set(null);
      this.restoreConfirmationFocus();
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to complete this action.');
      this.confirmationDialog.update((current) => (current ? { ...current, pending: false } : current));
    }
  }

  private openConfirmation(dialog: Omit<ConfirmationDialog, 'pending'>, handler: () => Promise<void> | void): void {
    this.confirmationReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.closeMediaMenu();
    this.confirmationHandler = handler;
    this.confirmationDialog.set({ ...dialog, pending: false });
    window.setTimeout(() => {
      const target = dialog.variant === 'danger' ? this.confirmCancelButton?.nativeElement : this.confirmPrimaryButton?.nativeElement;
      target?.focus();
    });
  }

  private restoreConfirmationFocus(): void {
    const target = this.confirmationReturnFocus;
    this.confirmationReturnFocus = null;
    window.setTimeout(() => {
      if (target?.isConnected) {
        target.focus();
      }
    });
  }

  private isEditableKeyboardTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    if (!element) {
      return false;
    }
    const tagName = element.tagName.toLowerCase();
    return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || element.isContentEditable;
  }

  protected async muteAllStudents(): Promise<void> {
    const roomId = this.currentRoomId();
    if (!roomId || !this.sessionLive() || !this.roomJoined() || this.mutingAllStudents() || !this.studentControlTargets().length) {
      return;
    }

    this.mutingAllStudents.set(true);
    this.setAllStudentActionPending('mute', true);
    this.mediaError.set('');
    try {
      const response = await this.socket.emitAck('class:mute-all-students', { roomId });
      this.applyClassModerationResult(response);
      this.mediaNotice.set(response.moderatedCount ? `Muted ${response.moderatedCount} student microphone${response.moderatedCount === 1 ? '' : 's'}.` : 'No active student microphones to mute.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to mute all student microphones.');
    } finally {
      this.setAllStudentActionPending('mute', false);
      this.mutingAllStudents.set(false);
    }
  }

  protected async stopAllStudentCameras(): Promise<void> {
    const roomId = this.currentRoomId();
    if (!roomId || !this.sessionLive() || !this.roomJoined() || this.stoppingAllStudentCameras() || !this.studentControlTargets().length) {
      return;
    }
    this.openConfirmation(
      {
        title: 'Stop all student cameras?',
        message: 'Every active student camera will be disabled for the class. Students will need camera permission again before publishing video.',
        confirmLabel: 'Stop cameras',
        cancelLabel: 'Cancel',
        pendingLabel: 'Stopping cameras...',
        variant: 'warning'
      },
      () => this.executeStopAllStudentCameras()
    );
  }

  private async executeStopAllStudentCameras(): Promise<void> {
    const roomId = this.currentRoomId();
    if (!roomId || !this.sessionLive() || !this.roomJoined() || this.stoppingAllStudentCameras() || !this.studentControlTargets().length) {
      return;
    }
    this.stoppingAllStudentCameras.set(true);
    this.setAllStudentActionPending('camera', true);
    this.mediaError.set('');
    try {
      const response = await this.socket.emitAck('class:stop-all-cameras', { roomId });
      this.applyClassModerationResult(response);
      this.mediaNotice.set(response.moderatedCount ? `Stopped ${response.moderatedCount} student camera${response.moderatedCount === 1 ? '' : 's'}.` : 'No active student cameras to stop.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to stop all student cameras.');
    } finally {
      this.setAllStudentActionPending('camera', false);
      this.stoppingAllStudentCameras.set(false);
    }
  }

  protected async toggleClassLock(): Promise<void> {
    const roomId = this.currentRoomId();
    if (!roomId || !this.sessionLive() || !this.roomJoined() || this.lockingClass()) {
      return;
    }

    const nextLocked = !this.roomLocked();
    this.lockingClass.set(true);
    this.mediaError.set('');
    try {
      if (nextLocked) {
        await this.socket.emitAck('room:lock', { roomId });
      } else {
        await this.socket.emitAck('room:unlock', { roomId });
      }
      this.mediaNotice.set(nextLocked ? 'Class locked for new joins.' : 'Class unlocked.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : nextLocked ? 'Unable to lock class.' : 'Unable to unlock class.');
    } finally {
      this.lockingClass.set(false);
    }
  }

  protected downloadAttendance(): void {
    const session = this.session();
    if (!session || this.downloadingAttendance()) {
      return;
    }

    this.downloadingAttendance.set(true);
    this.mediaError.set('');
    this.classSessions.downloadAttendance(session.sessionId, session.batchId).subscribe({
      next: (blob) => {
        this.saveBlob(blob, `class-session-${session.sessionNumber}-attendance.csv`);
        this.mediaNotice.set('Attendance downloaded.');
        this.downloadingAttendance.set(false);
      },
      error: (error) => {
        this.mediaError.set(this.classSessions.errorMessage(error));
        this.downloadingAttendance.set(false);
      }
    });
  }

  protected attachWhiteboardNotes(): void {
    void this.saveWhiteboardMemory('export', true).catch(() => null);
    void this.uploadWhiteboardNotes(
      `class-session-${this.session()?.sessionNumber ?? 'live'}-annotated-notes`,
      'Whiteboard notes attached and shared with students.'
    );
  }

  protected saveWhiteboardCheckpoint(): void {
    if (this.whiteboardMemoryBusy() || this.whiteboardSaveConflict()) return;
    this.whiteboardMemoryBusy.set(true);
    void this.saveWhiteboardMemory('manual-save', true).then(() => {
      this.whiteboardMemoryBusy.set(false);
      this.loadWhiteboardVersions();
    }).catch(() => this.whiteboardMemoryBusy.set(false));
  }

  protected loadWhiteboardVersions(): void {
    const session = this.session();
    if (!session || this.whiteboardMemoryBusy()) {
      return;
    }
    this.whiteboardMemoryBusy.set(true);
    this.classSessions.listWhiteboardVersions(session.sessionId, { batchId: session.batchId }).subscribe({
      next: (response) => {
        this.whiteboardVersions.set(response.versions);
        this.whiteboardMemoryNotice.set(response.versions.length ? 'Checkpoints loaded.' : 'No checkpoints yet.');
        this.whiteboardMemoryBusy.set(false);
      },
      error: (error) => {
        this.whiteboardMemoryNotice.set(this.classSessions.errorMessage(error));
        this.whiteboardMemoryBusy.set(false);
      }
    });
  }

  protected restoreWhiteboardVersion(versionId: string): void {
    const session = this.session();
    if (!session || !versionId) return;
    this.queueWhiteboardRestore((guard) => this.classSessions.restoreWhiteboardVersion(session.sessionId, versionId, { batchId: session.batchId, ...guard }), 'Checkpoint restored.');
  }

  protected loadPreviousWhiteboards(): void {
    const session = this.session();
    if (!session || this.whiteboardMemoryBusy()) {
      return;
    }
    this.whiteboardMemoryBusy.set(true);
    this.classSessions.listPreviousWhiteboards(session.sessionId, { batchId: session.batchId }).subscribe({
      next: (response) => {
        this.previousWhiteboards.set(response.boards);
        this.whiteboardMemoryNotice.set(response.boards.length ? 'Previous boards loaded.' : 'No previous boards found for this batch.');
        this.whiteboardMemoryBusy.set(false);
      },
      error: (error) => {
        this.whiteboardMemoryNotice.set(this.classSessions.errorMessage(error));
        this.whiteboardMemoryBusy.set(false);
      }
    });
  }

  protected restorePreviousWhiteboard(sourceSessionId: string): void {
    const session = this.session();
    if (!session || !sourceSessionId) return;
    this.queueWhiteboardRestore((guard) => this.classSessions.restorePreviousWhiteboard(session.sessionId, { batchId: session.batchId, sourceSessionId, ...guard }), 'Previous session board restored.');
  }

  private queueWhiteboardRestore(
    load: (guard: { expectedSnapshotVersion: number; expectedLastOperationSeq: number }) => Observable<WhiteboardMemoryState>,
    notice: string
  ): void {
    if (this.whiteboardMemoryBusy() || !this.whiteboardMemoryReady || this.whiteboardSaveConflict()) return;
    this.whiteboardMemoryBusy.set(true);
    this.clearWhiteboardAutosaveTimer();
    const restore = this.whiteboardSyncTail.then(async () => {
      if (this.whiteboardSaveConflict()) return;
      const revision = this.whiteboardEditRevision;
      const state = await firstValueFrom(load(this.whiteboardSaveGuard()));
      const roomId = this.currentRoomId();
      if (roomId) await this.socket.emitAck('whiteboard:refresh', { roomId }).catch(() => this.socket.emitAck('whiteboard:refresh', { roomId }));
      if (revision !== this.whiteboardEditRevision) {
        this.whiteboardSaveConflict.set(true);
        this.whiteboardMemoryNotice.set('The board changed during restore. Your local board is preserved; reload the saved board to reconcile it.');
        return;
      }
      this.applyWhiteboardMemoryState(state);
      this.whiteboardMemoryNotice.set(notice);
    });
    this.whiteboardSyncTail = restore.catch((error) => {
      this.whiteboardSaveConflict.set(true);
      this.whiteboardMemoryNotice.set(this.classSessions.errorMessage(error));
    }).finally(() => this.whiteboardMemoryBusy.set(false));
  }

  private async uploadWhiteboardNotes(fileBaseName: string, successNotice: string): Promise<boolean> {
    const session = this.session();
    if (!session || !this.sessionLive() || !this.teacherCanUploadMaterials() || this.attachingWhiteboardNotes()) {
      return Promise.resolve(false);
    }
    this.attachingWhiteboardNotes.set(true);
    let exported;
    try {
      exported = await this.whiteboard?.exportAllPagesPdfBlob(fileBaseName);
    } catch (error) {
      this.attachingWhiteboardNotes.set(false);
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to export whiteboard notes.');
      return false;
    }
    if (!exported) {
      this.attachingWhiteboardNotes.set(false);
      this.mediaError.set('Unable to export whiteboard notes from this browser.');
      return false;
    }

    const file = new File([exported.blob], exported.fileName, {
      type: 'application/pdf',
      lastModified: Date.now()
    });
    this.mediaError.set('');
    return new Promise((resolve) => {
      this.classSessions.uploadMaterials(session.sessionId, [file], { batchId: session.batchId }).subscribe({
        next: (materials) => {
          const material = materials[0];
          if (!material) {
            void this.materialsPanel?.reload();
            this.mediaNotice.set('Whiteboard notes attached to class materials.');
            this.attachingWhiteboardNotes.set(false);
            resolve(true);
            return;
          }
          this.classSessions.shareMaterial(session.sessionId, material.materialId, { batchId: session.batchId }).subscribe({
            next: () => {
              void this.materialsPanel?.reload();
              this.mediaNotice.set(successNotice);
              this.attachingWhiteboardNotes.set(false);
              resolve(true);
            },
            error: (error) => {
              void this.materialsPanel?.reload();
              this.mediaError.set(`Notes were attached, but could not be shared live. ${this.classSessions.errorMessage(error)}`);
              this.attachingWhiteboardNotes.set(false);
              resolve(false);
            }
          });
        },
        error: (error) => {
          this.mediaError.set(this.classSessions.errorMessage(error));
          this.attachingWhiteboardNotes.set(false);
          resolve(false);
        }
      });
    });
  }

  protected startRecording(): void {
    const session = this.session();
    if (!session || !this.sessionLive() || this.recordingActionPending() || this.recordingActive()) {
      return;
    }
    if (!this.recordingEnabled()) {
      this.mediaError.set('Recording is disabled for this class.');
      return;
    }
    if (!this.teacherRecordingControlEnabled()) {
      this.mediaError.set('Teacher recording control is disabled for this class.');
      return;
    }
    this.openConfirmation(
      {
        title: 'Start class recording?',
        message: 'The lesson, shared content, and class audio will be recorded. Students will see the recording indicator.',
        confirmLabel: 'Start recording',
        cancelLabel: 'Cancel',
        pendingLabel: 'Starting recording...',
        variant: 'warning'
      },
      () => this.executeStartRecording()
    );
  }

  private executeStartRecording(): Promise<void> {
    const session = this.session();
    if (!session || !this.sessionLive() || this.recordingActionPending() || this.recordingActive()) {
      return Promise.resolve();
    }
    this.recordingActionPending.set(true);
    this.mediaError.set('');
    return new Promise((resolve) => {
      this.classSessions.startRecording(session.sessionId).subscribe({
        next: (recording) => {
          this.applyRecording(recording);
          void this.ensureLessonCapture(recording);
          this.mediaNotice.set('Recording started.');
          this.recordingActionPending.set(false);
          resolve();
        },
        error: (error) => {
          this.mediaError.set(this.classSessions.errorMessage(error));
          this.recordingActionPending.set(false);
          resolve();
        }
      });
    });
  }

  protected stopRecording(): void {
    const session = this.session();
    if (!session || !this.recordingActive() || this.recordingActionPending()) return;
    this.recordingActionPending.set(true);
    this.mediaError.set('');
    const stopping = this.lessonRecorder.activeId()
      ? this.lessonRecorder.stop()
      : firstValueFrom(this.classSessions.stopRecording(session.sessionId)).then((recording) => { this.applyRecording(recording); });
    void stopping.then(() => this.mediaNotice.set(this.lessonRecorder.notice() || 'Recording stopped.'))
      .catch(() => this.mediaNotice.set(this.lessonRecorder.notice() || 'Saved recording will upload when connected.'))
      .finally(() => this.recordingActionPending.set(false));
  }

  private async ensureLessonCapture(recording = this.activeRecording()): Promise<void> {
    const session = this.session();
    const id = recording?.recordingId ?? recording?.id;
    if (!session || !id || !this.roomJoined() || !this.isActiveRecording(recording) || this.lessonRecorder.activeId() || this.recordingCaptureStarting) return;
    this.recordingCaptureStarting = true;
    try {
      await this.lessonRecorder.start(id, session.sessionId, {
        board: () => this.host.nativeElement.querySelector('sfu-whiteboard canvas'),
        screen: () => this.presentedDeviceStream() ?? this.webrtc.screenStream(),
        camera: () => this.webrtc.localStream(),
        audio: () => [this.webrtc.localStream(), this.webrtc.screenStream(), ...this.webrtc.remoteStreams().map((entry) => entry.stream)].filter((stream): stream is MediaStream => Boolean(stream))
      });
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to capture lesson media.');
    } finally { this.recordingCaptureStarting = false; }
  }

  protected toggleRecording(): void {
    if (!this.recordingEnabled() && !this.recordingActive()) {
      this.mediaError.set('Recording is disabled for this class.');
      return;
    }
    if (!this.teacherRecordingControlEnabled() && !this.recordingActive()) {
      this.mediaError.set('Teacher recording control is disabled for this class.');
      return;
    }
    if (this.recordingActive()) {
      this.stopRecording();
      return;
    }
    this.startRecording();
  }

  protected downloadLatestRecording(): void {
    const session = this.session();
    const recording = this.latestRecording();
    const recordingId = recording?.recordingId ?? recording?.id;
    if (!session || !recordingId || this.downloadingRecording()) {
      return;
    }
    this.downloadingRecording.set(true);
    this.mediaError.set('');
    this.classSessions.downloadRecording(session.sessionId, recordingId, session.batchId).subscribe({
      next: (blob) => {
        this.saveBlob(blob, `class-session-${session.sessionNumber}-recording.json`);
        this.mediaNotice.set('Recording downloaded.');
        this.downloadingRecording.set(false);
      },
      error: (error) => {
        this.mediaError.set(this.classSessions.errorMessage(error));
        this.downloadingRecording.set(false);
      }
    });
  }

  protected async preparePrivately(): Promise<void> {
    if (this.session()?.status !== 'scheduled') return;
    this.preflightOpen.set(false);
    await this.stopPreflightPreview();
    this.privatePreparation.set(true);
    setTimeout(() => {
      void this.recoveryStore.get<{ snapshot: ReturnType<Whiteboard['exportBoardState']> }>(this.localDraftKey()).then((draft) => {
        if (draft && !this.sessionLive()) this.whiteboard?.importBoardState(draft.snapshot);
      }).catch(() => undefined);
    });
  }

  protected async openPreflight(): Promise<void> {
    const session = this.session();
    if (!session || this.preflightOpen() || this.roomJoined() || session.status === 'completed' || session.status === 'cancelled') {
      return;
    }
    this.preflightOpen.set(true);
    this.preflightError.set('');
    await this.preparePreflightPreview();
  }

  protected async cancelPreflight(): Promise<void> {
    await this.stopPreflightPreview();
    this.preflightOpen.set(false);
    const batchId = this.session()?.batchId;
    await this.router.navigate(this.desktopSession ? ['/desktop/upcoming'] : batchId ? ['/teacher/dashboard/batches', batchId] : ['/teacher/dashboard']);
  }

  protected async refreshPreflightDevices(): Promise<void> {
    await this.preparePreflightPreview();
  }

  protected async switchPreflightMicrophone(deviceId: string): Promise<void> {
    await this.switchPreflightDevice('audio', deviceId);
  }

  protected async switchPreflightCamera(deviceId: string): Promise<void> {
    await this.switchPreflightDevice('video', deviceId);
  }

  protected confirmPreflight(): void {
    const session = this.session();
    if (!session || !this.preflightCanConfirm()) {
      return;
    }
    this.preflightActionPending.set(true);
    this.preflightError.set('');
    this.mediaError.set('');
    if (this.preflightMode() === 'start') {
      this.classSessions.startSession(session.sessionId, session.batchId).subscribe({
        next: (payload) => {
          this.applyPayload(payload);
          void this.enterLiveClassFromPreflight(payload);
        },
        error: (error) => {
          this.preflightError.set(this.classSessions.errorMessage(error));
          this.preflightActionPending.set(false);
        }
      });
      return;
    }
    void this.enterLiveClassFromPreflight(session);
  }

  private loadSession(): void {
    const sessionId = this.route.snapshot.queryParamMap.get('sessionId') ?? '';
    const batchId = this.route.snapshot.queryParamMap.get('batchId') ?? '';
    if (!sessionId || !batchId) {
      this.loading.set(false);
      this.error.set('Open this class from a scheduled batch session.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.classSessions.getSession(sessionId, batchId).subscribe({
      next: (payload) => {
        this.applyPayload(payload);
        this.loading.set(false);
        if (payload.status === 'live' || payload.status === 'scheduled') {
          void this.openPreflight();
        }
      },
      error: (error) => {
        this.error.set(this.classSessions.errorMessage(error));
        this.loading.set(false);
      }
    });
  }

  private applyPayload(payload: ClassroomPayload, options: { leaveOnTerminal?: boolean } = {}): void {
    if (!this.isTerminalStatus(payload.status)) {
      this.terminalSessionHandled = false;
    }
    this.session.set(payload);
    this.watchSession(payload.sessionId, payload.batchId);
    this.participants.set(payload.participants.map((participant) => this.classroomParticipantToCard(participant)));
    this.syncParticipantsFromRoom();
    if (payload.status === 'live') {
      this.scheduleWhiteboardMemoryLoad(payload);
    }
    if (this.isTerminalStatus(payload.status)) {
      this.markSessionTerminal(payload.status, payload.completedAt);
      if (options.leaveOnTerminal !== false) {
        void this.leaveCurrentRoom();
      }
    }
  }

  private async joinAndPublish(payload: ClassroomPayload, options: { showLoading: boolean }): Promise<boolean> {
    if (!payload.roomId || payload.status !== 'live' || this.joiningRoom()) {
      return false;
    }
    if (options.showLoading) {
      this.loading.set(true);
    }
    this.joiningRoom.set(true);
    this.mediaError.set('');
    this.mediaNotice.set('');
    try {
      await this.waitForSocketConnection();
      const response = await this.socket.emitAck('room:join', {
        roomId: payload.roomId,
        displayName: this.teacherDisplayName(payload),
        asViewer: false
      });
      if (this.destroyed) {
        await this.socket.emitAck('room:leave', { roomId: payload.roomId }).catch(() => undefined);
        return false;
      }
      this.joinedRoomId = payload.roomId;
      this.roomJoined.set(true);
      void window.classroomDesktop?.setClassActive(true);
      this.store.setRoom(response.room);
      this.store.setLocalParticipant(response.participantId);
      if (this.reconnectingRoom) void this.reloadWhiteboardAfterReconnect(payload);
      this.syncParticipantsFromRoom();
      void this.consumeAvailableStudentProducers();
      this.startActivityHeartbeat();
      this.joiningRoom.set(false);
      if (await this.publishCamera(payload.roomId)) {
        void this.ensureLessonCapture();
        this.mediaNotice.set(this.audioOnlyPreparation() ? 'Microphone is live. Camera is off.' : 'Camera and audio are live.');
        return true;
      }
      return false;
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to join the live room.');
      return false;
    } finally {
      this.joiningRoom.set(false);
      if (options.showLoading) {
        this.loading.set(false);
      }
    }
  }

  private async publishCamera(roomId: string): Promise<boolean> {
    this.publishingCamera.set(true);
    this.mediaError.set('');
    let audioProducer: Producer | null = null;
    let videoProducer: Producer | null = null;
    try {
      const stream = await this.ensureTeacherPreviewStream();
      this.syncSelectedDevices(stream);
      const transport = await this.webrtc.preparePeer(roomId);
      if (stream.getAudioTracks().length) { audioProducer = await this.webrtc.publish(roomId, transport, 'audio', stream); this.addLocalProducer(audioProducer); this.applyProducerPolicyNotice(audioProducer); }
      if (stream.getVideoTracks().length) { videoProducer = await this.webrtc.publish(roomId, transport, 'video', stream); this.addLocalProducer(videoProducer); this.applyProducerPolicyNotice(videoProducer); }
      this.cameraPublished.set(true);
      return true;
    } catch (error) {
      this.mediaError.set(this.mediaRecoveryError()?.message ?? (error instanceof Error ? error.message : 'Unable to publish teacher camera and audio.'));
      await this.closeLocalProducers([audioProducer?.id, videoProducer?.id].filter((id): id is string => Boolean(id)));
      this.webrtc.stopCamera();
      this.cameraPublished.set(false);
      return false;
    } finally {
      this.publishingCamera.set(false);
    }
  }

  private async enterLiveClassFromPreflight(payload: ClassroomPayload): Promise<void> {
    if (this.destroyed) {
      return;
    }
    if (payload.status !== 'live' || !payload.roomId) {
      this.preflightError.set('This session is not live yet.');
      this.preflightActionPending.set(false);
      return;
    }
    if (this.privatePreparation()) await this.persistLocalDraft();
    const joined = await this.joinAndPublish(payload, { showLoading: !this.privatePreparation() });
    this.preflightActionPending.set(false);
    if (!joined) {
      this.preflightError.set(this.mediaError() || 'Unable to enter the live room. Check your setup and try again.');
      this.preflightOpen.set(true);
      return;
    }
    this.preflightOpen.set(false);
    await this.stopPreflightPreview({ keepStream: true });
    if (this.privatePreparation() && !(await this.publishPrivateWhiteboard(payload))) return;
    this.scheduleWhiteboardMemoryLoad(payload, true);
  }

  private async publishPrivateWhiteboard(payload: ClassroomPayload): Promise<boolean> {
    try {
      const baseline = await firstValueFrom(this.classSessions.getWhiteboardMemory(payload.sessionId, { batchId: payload.batchId }));
      if (this.destroyed || !this.whiteboard) return false;
      this.whiteboardMemoryState.set(baseline);
      this.whiteboardMemoryReady = true;
      this.whiteboardMemoryLoadedSessionId = payload.sessionId;
      const saved = await this.saveWhiteboardMemory('autosave', false);
      if (!saved) throw new Error('Prepared board is waiting to synchronize.');
      this.privatePreparation.set(false);
      await this.socket.emitAck('whiteboard:refresh', { roomId: payload.roomId });
      return true;
    } catch {
      this.privatePreparation.set(false);
      this.whiteboardSaveConflict.set(true);
      this.whiteboardMemorySaveState.set('failed');
      this.whiteboardMemoryNotice.set('Your prepared board is kept on this device. Restore the local draft to retry publishing it.');
      if (this.whiteboard) this.localDraft.set({ snapshot: this.whiteboard.exportBoardState(), savedAt: new Date().toISOString() });
      return false;
    }
  }

  protected async useMicrophoneOnly(): Promise<void> {
    this.audioOnlyPreparation.set(true);
    await this.preparePreflightPreview();
  }

  protected async enablePreflightCamera(): Promise<void> {
    this.audioOnlyPreparation.set(false);
    await this.preparePreflightPreview();
  }

  protected async preparePreflightPreview(): Promise<void> {
    if (this.preflightPreparing()) {
      return;
    }
    this.preflightPreparing.set(true);
    this.preflightError.set('');
    this.preflightSocketReady.set(this.realtimeSocket.connected);
    try {
      await this.deviceWebRtc.refreshDevices();
      this.stopMicrophoneMeter();
      this.webrtc.stopCamera();
      const stream = this.audioOnlyPreparation() ? await this.webrtc.startMicrophone(this.selectedAudioDeviceId() || undefined) : await this.webrtc.startCamera(this.selectedAudioDeviceId() || undefined, this.selectedVideoDeviceId() || undefined);
      this.syncSelectedDevices(stream);
      await this.startMicrophoneMeter(stream);
      this.preflightSocketReady.set(this.realtimeSocket.connected);
    } catch (error) {
      this.preflightError.set(this.mediaDeviceErrorMessage(error, 'Unable to start camera and microphone preview.'));
      this.stopMicrophoneMeter();
    } finally {
      this.preflightPreparing.set(false);
    }
  }

  private async switchPreflightDevice(kind: 'audio' | 'video', deviceId: string): Promise<void> {
    const nextDeviceId = deviceId.trim();
    const switchingSignal = kind === 'audio' ? this.switchingAudioDevice : this.switchingVideoDevice;
    if (switchingSignal()) {
      return;
    }
    this.preflightError.set('');
    switchingSignal.set(true);
    try {
      if (!this.preflightPreviewStream()) {
        this.setSelectedDeviceId(kind, nextDeviceId);
        await this.preparePreflightPreview();
        return;
      }
      if (kind === 'audio') {
        if (typeof this.deviceWebRtc.switchMicrophone !== 'function') {
          throw new Error('Microphone switching is not available.');
        }
        await this.deviceWebRtc.switchMicrophone(nextDeviceId);
      } else {
        if (typeof this.deviceWebRtc.switchCamera !== 'function') {
          throw new Error('Camera switching is not available.');
        }
        await this.deviceWebRtc.switchCamera(nextDeviceId);
      }
      this.setSelectedDeviceId(kind, nextDeviceId);
      const stream = this.preflightPreviewStream();
      if (stream) {
        this.syncSelectedDevices(stream);
        if (kind === 'audio') {
          await this.startMicrophoneMeter(stream);
        }
      }
    } catch (error) {
      this.preflightError.set(this.mediaDeviceErrorMessage(error, kind === 'audio' ? 'Unable to switch microphone.' : 'Unable to switch camera.'));
    } finally {
      switchingSignal.set(false);
    }
  }

  private async ensureTeacherPreviewStream(): Promise<MediaStream> {
    const stream = this.preflightPreviewStream();
    const hasAudio = stream?.getAudioTracks().some((track) => track.readyState === 'live');
    const hasVideo = stream?.getVideoTracks().some((track) => track.readyState === 'live');
    if (stream && hasAudio && (hasVideo || this.audioOnlyPreparation())) {
      return stream;
    }
    return this.audioOnlyPreparation() ? this.webrtc.startMicrophone(this.selectedAudioDeviceId() || undefined) : this.webrtc.startCamera(this.selectedAudioDeviceId() || undefined, this.selectedVideoDeviceId() || undefined);
  }

  private async stopPreflightPreview(options: { keepStream?: boolean } = {}): Promise<void> {
    this.stopMicrophoneMeter();
    this.microphoneLevel.set(0);
    this.preflightPreparing.set(false);
    if (!options.keepStream) {
      this.webrtc.stopCamera();
    }
  }

  private async startMicrophoneMeter(stream: MediaStream): Promise<void> {
    this.stopMicrophoneMeter();
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      this.microphoneLevel.set(0);
      return;
    }
    const audioContext = new AudioContext();
    await audioContext.resume().catch(() => undefined);
    const source = audioContext.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    this.preflightAudioContext = audioContext;
    this.preflightAnalyser = analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (!this.preflightAnalyser) {
        return;
      }
      this.preflightAnalyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const offset = value - 128;
        sum += offset * offset;
      }
      const rms = Math.sqrt(sum / data.length);
      this.microphoneLevel.set(Math.min(100, Math.round(rms * 4)));
      this.preflightMeterFrame = window.requestAnimationFrame(tick);
    };
    tick();
  }

  private stopMicrophoneMeter(): void {
    if (this.preflightMeterFrame) {
      window.cancelAnimationFrame(this.preflightMeterFrame);
      this.preflightMeterFrame = 0;
    }
    const audioContext = this.preflightAudioContext;
    this.preflightAnalyser = undefined;
    this.preflightAudioContext = undefined;
    if (audioContext && audioContext.state !== 'closed') {
      void audioContext.close().catch(() => undefined);
    }
  }

  private mediaDeviceErrorMessage(error: unknown, fallback: string): string {
    const recoveryError = this.mediaRecoveryError();
    if (recoveryError?.message) {
      return recoveryError.message;
    }
    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
        return 'Camera or microphone permission was blocked. Allow access in your browser, then try again.';
      }
      if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
        return 'Selected camera or microphone is unavailable. Choose another device.';
      }
    }
    return error instanceof Error && error.message ? error.message : fallback;
  }

  protected async shareScreen(): Promise<void> {
    const roomId = this.joinedRoomId || this.session()?.roomId;
    if (!roomId || !this.roomJoined() || this.publishingScreen() || this.publishingWhiteboard() || this.stoppingScreen()) return;
    const epoch = ++this.screenCaptureEpoch;
    const previousProducerId = this.screenProducerId;
    const previousStream = this.webrtc.screenStream();
    const previousBoardStream = this.whiteboardCaptureStream;
    const wasWhiteboard = this.whiteboardSharing();
    let candidate: MediaStream | null = null;
    let published: Producer | null = null;
    this.publishingScreen.set(true); this.mediaError.set('');
    try {
      candidate = await this.webrtc.captureScreen();
      if (this.destroyed || epoch !== this.screenCaptureEpoch || !this.roomJoined() || this.joinedRoomId !== roomId) throw new Error('The class connection changed. Choose your device whiteboard again after reconnecting.');
      const presenter = this.presentedDeviceProducer();
      if (presenter && presenter.participantId !== this.store.localParticipantId() && !await this.setDeviceSharingPermission(presenter.participantId, false)) throw new Error('Could not end the current student presentation.');
      this.replacingScreenSource = true;
      const transport = await this.webrtc.preparePeer(roomId);
      published = await this.webrtc.publish(roomId, transport, 'screen', candidate, { source: 'screen' });
      if (this.destroyed || epoch !== this.screenCaptureEpoch || !this.roomJoined()) throw new Error('The class connection changed while starting sharing.');
      this.screenProducerId = published.id;
      this.addLocalProducer(published);
      this.webrtc.screenStream.set(candidate);
      this.whiteboardCaptureStream = null; this.whiteboardSharing.set(false);
      this.lastSharedContentSource.set('screen'); this.whiteboardSourceChoice.set('device');
      if (previousProducerId && previousProducerId !== published.id) { this.webrtc.releaseLocalProducer(previousProducerId); this.localProducerIds.delete(previousProducerId); this.store.removeProducer(previousProducerId); }
      previousStream?.getTracks().forEach((track) => track.stop());
      if (wasWhiteboard && previousBoardStream) {
        previousBoardStream.getTracks().forEach((track) => track.stop());
        this.whiteboard?.stopMediaCapture();
      }
      const activeCandidate = candidate;
      activeCandidate.getVideoTracks()[0]?.addEventListener('ended', () => { if (this.webrtc.screenStream() === activeCandidate) void this.handleScreenTrackEnded(); }, { once: true });
      this.applyProducerPolicyNotice(published); this.mediaNotice.set('Device whiteboard is shared as video. Your classroom whiteboard is saved.');
      candidate = null;
    } catch (error) {
      if (published) { await this.webrtc.closeProducer(published.id).catch(() => this.webrtc.releaseLocalProducer(published!.id)); this.store.removeProducer(published.id); }
      candidate?.getTracks().forEach((track) => track.stop());
      this.clearReplacedScreenAfterFailure(previousProducerId);
      this.whiteboardSourceChoice.set(this.screenSharing() ? 'device' : 'classroom');
      this.mediaError.set(error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError') ? 'Sharing was cancelled or not allowed. Your current whiteboard is unchanged.' : error instanceof Error ? error.message : 'Unable to share your device whiteboard.');
    } finally { this.replacingScreenSource = false; this.publishingScreen.set(false); }
  }

  private async shareWhiteboard(): Promise<void> {
    const roomId = this.joinedRoomId || this.session()?.roomId;
    if (!roomId || !this.roomJoined() || this.publishingWhiteboard() || this.publishingScreen() || this.whiteboardSharing()) return;
    const stream = this.whiteboard?.captureMediaStream(15);
    if (!stream) {
      this.mediaError.set('Whiteboard capture is not available in this browser. Choose Share device whiteboard instead.');
      return;
    }
    const epoch = ++this.screenCaptureEpoch;
    const previousProducerId = this.screenProducerId;
    const previousStream = this.webrtc.screenStream();
    let producer: Producer | null = null;
    this.publishingWhiteboard.set(true);
    this.replacingScreenSource = true;
    this.mediaError.set('');
    try {
      const transport = await this.webrtc.preparePeer(roomId);
      producer = await this.webrtc.publish(roomId, transport, 'screen', stream, { source: 'whiteboard' });
      if (this.destroyed || epoch !== this.screenCaptureEpoch || !this.roomJoined() || this.joinedRoomId !== roomId) throw new Error('The class connection changed while starting sharing.');
      this.screenProducerId = producer.id;
      this.whiteboardCaptureStream = stream;
      this.webrtc.screenStream.set(stream);
      this.whiteboardSharing.set(true);
      this.lastSharedContentSource.set('whiteboard');
      this.whiteboardSourceChoice.set('classroom');
      this.addLocalProducer(producer);
      if (previousProducerId && previousProducerId !== producer.id) {
        this.webrtc.releaseLocalProducer(previousProducerId);
        this.localProducerIds.delete(previousProducerId);
        this.store.removeProducer(previousProducerId);
      }
      previousStream?.getTracks().forEach((track) => track.stop());
      stream.getVideoTracks()[0]?.addEventListener('ended', () => { if (this.webrtc.screenStream() === stream) void this.handleScreenTrackEnded(); }, { once: true });
      this.applyProducerPolicyNotice(producer);
      this.whiteboard?.requestCaptureFrame(stream);
      this.mediaNotice.set('Whiteboard sharing is live.');
    } catch (error) {
      if (producer) {
        await this.webrtc.closeProducer(producer.id).catch(() => this.webrtc.releaseLocalProducer(producer!.id));
        this.store.removeProducer(producer.id);
      }
      stream.getTracks().forEach((track) => track.stop());
      this.whiteboard?.stopMediaCapture();
      this.clearReplacedScreenAfterFailure(previousProducerId);
      this.mediaError.set(this.mediaRecoveryError()?.message ?? (error instanceof Error ? error.message : 'Unable to share the whiteboard.'));
    } finally {
      this.replacingScreenSource = false;
      this.publishingWhiteboard.set(false);
    }
  }

  // A server replacement can complete before SDP negotiation fails locally.
  // Keep the old source only while it still exists in the room snapshot.
  private clearReplacedScreenAfterFailure(previousProducerId: string): void {
    if (!previousProducerId || this.store.room()?.producers.some((producer) => producer.id === previousProducerId && producer.status !== 'closed')) return;
    this.webrtc.releaseLocalProducer(previousProducerId);
    this.localProducerIds.delete(previousProducerId);
    if (this.screenProducerId === previousProducerId) {
      this.screenProducerId = '';
      this.clearWhiteboardShareState();
      this.webrtc.stopScreen();
      this.whiteboardSourceChoice.set('classroom');
    }
  }

  private async stopScreenShare(): Promise<void> {
    if (this.stoppingScreen()) {
      return;
    }
    this.stoppingScreen.set(true);
    this.mediaError.set('');
    const producerId = this.screenProducerId;
    const wasWhiteboardSharing = this.whiteboardSharing();
    let stopped = false;
    try {
      if (producerId) {
        await this.closeLocalProducers([producerId], { strict: true });
      }
      stopped = true;
      this.mediaNotice.set(wasWhiteboardSharing ? 'Whiteboard sharing stopped.' : 'Screen sharing stopped.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : wasWhiteboardSharing ? 'Unable to stop whiteboard sharing on the server.' : 'Unable to stop screen sharing on the server.');
    } finally {
      if (stopped || !producerId) {
        this.clearWhiteboardShareState();
        this.webrtc.stopScreen();
        this.screenProducerId = '';
      }
      this.stoppingScreen.set(false);
      this.syncParticipantsFromRoom();
    }
  }

  private async handleScreenTrackEnded(): Promise<void> {
    if (!this.roomJoined() || !this.screenProducerId) {
      this.clearWhiteboardShareState();
      this.webrtc.stopScreen();
      this.whiteboardSourceChoice.set('classroom');
      return;
    }
    await this.stopScreenShare();
    this.whiteboardSourceChoice.set('classroom');
    if (this.roomJoined() && this.whiteboardSharingEnabled()) await this.shareWhiteboard();
  }

  private clearWhiteboardShareState(): void {
    this.whiteboardCaptureStream?.getTracks().forEach((track) => track.stop());
    this.whiteboardCaptureStream = null;
    this.whiteboard?.stopMediaCapture();
    this.whiteboardSharing.set(false);
    this.publishingWhiteboard.set(false);
  }

  private async leaveCurrentRoom(): Promise<void> {
    const roomId = this.joinedRoomId;
    this.joinedRoomId = '';
    this.stopActivityHeartbeat();
    await this.closeLocalProducers();
    this.cleanupRoomMediaLocally();
    if (roomId) {
      await this.waitForSocketConnection().catch(() => undefined);
      if (this.realtimeSocket.connected) {
        await this.socket.emitAck('room:leave', { roomId }).catch(() => undefined);
      }
    }
  }

  private addLocalProducer(producer: Producer): void {
    this.localProducerIds.add(producer.id);
    if (producer.kind === 'screen') {
      this.screenProducerId = producer.id;
    }
    this.store.upsertProducer(producer);
  }

  private async closeLocalProducers(producerIds = [...this.localProducerIds], options: CloseLocalProducerOptions = {}): Promise<void> {
    const uniqueProducerIds = [...new Set(producerIds)];
    const errors: unknown[] = [];
    await Promise.all(
      uniqueProducerIds.map(async (producerId) => {
        let closeFailed = false;
        try {
          if (this.realtimeSocket.connected) {
            await this.webrtc.closeProducer(producerId);
          } else if (options.strict) {
            throw new Error('Socket is disconnected. Reconnect before stopping shared media.');
          }
        } catch (error) {
          // The socket or room may already be gone during disconnect/end-session cleanup.
          closeFailed = true;
          if (options.strict) {
            errors.push(error);
          }
        }
        if (closeFailed && options.strict) {
          return;
        }
        this.localProducerIds.delete(producerId);
        if (producerId === this.screenProducerId) {
          this.screenProducerId = '';
          this.clearWhiteboardShareState();
        }
        this.store.removeProducer(producerId);
      })
    );
    if (errors.length) {
      const error = errors[0];
      throw error instanceof Error ? error : new Error('Unable to close shared media.');
    }
  }

  private cleanupRoomMediaLocally(): void {
    this.screenCaptureEpoch++;
    this.whiteboardSourceChoice.set('classroom');
    this.stopMicrophoneMeter();
    this.microphoneLevel.set(0);
    this.screenProducerId = '';
    this.roomJoined.set(false);
    this.cameraPublished.set(false);
    this.publishingCamera.set(false);
    this.publishingScreen.set(false);
    this.publishingWhiteboard.set(false);
    this.stoppingScreen.set(false);
    this.clearWhiteboardShareState();
    this.refreshingDevices.set(false);
    this.switchingAudioDevice.set(false);
    this.switchingVideoDevice.set(false);
    this.localProducerIds.clear();
    this.consumedStudentProducerIds.clear();
    this.pendingStudentProducerIds.clear();
    this.consumerProducerIds.clear();
    this.locallyHiddenParticipantIds.set([]);
    this.pendingParticipantActions.set({});
    this.clearWhiteboardControlState();
    this.webrtc.resetRoomMedia();
  }

  private cleanupRemovedRoomProducers(nextRoom: Room): void {
    const currentRoom = this.store.room();
    if (!currentRoom || !this.isCurrentRoom(currentRoom.id)) {
      return;
    }
    const nextProducerIds = new Set(nextRoom.producers.map((producer) => producer.id));
    for (const producer of currentRoom.producers) {
      if (nextProducerIds.has(producer.id)) {
        continue;
      }
      if (producer.id === this.screenProducerId) {
        this.localProducerIds.delete(producer.id);
        if (!this.replacingScreenSource) {
          this.screenProducerId = '';
          this.webrtc.releaseLocalProducer(producer.id);
          this.clearWhiteboardShareState();
          this.webrtc.stopScreen();
          this.whiteboardSourceChoice.set('classroom');
        }
      }
      this.cleanupStudentProducer(producer.id);
    }
  }

  private markSessionTerminal(status: TerminalClassSessionStatus = 'completed', completedAt?: string): void {
    this.cleanupTerminalUiState();
    const current = this.session();
    if (!current) {
      return;
    }
    this.session.set({
      ...current,
      status,
      canJoin: false,
      ...(status === 'completed' ? { completedAt: completedAt ?? current.completedAt ?? new Date().toISOString() } : {})
    });
    this.terminalSessionHandled = true;
  }

  private cleanupTerminalUiState(): void {
    this.clearWhiteboardAutosaveTimer();
    this.preflightOpen.set(false);
    this.preflightPreparing.set(false);
    this.preflightActionPending.set(false);
    this.joiningRoom.set(false);
    this.publishingCamera.set(false);
    this.publishingScreen.set(false);
    this.publishingWhiteboard.set(false);
    this.stoppingScreen.set(false);
    this.clearWhiteboardShareState();
    this.refreshingDevices.set(false);
    this.switchingAudioDevice.set(false);
    this.switchingVideoDevice.set(false);
    this.mutingAllStudents.set(false);
    this.stoppingAllStudentCameras.set(false);
    this.lockingClass.set(false);
    this.recordingActionPending.set(false);
    this.downloadingRecording.set(false);
    this.ending.set(false);
    this.pendingParticipantActions.set({});
    this.clearWhiteboardControlState();
  }

  private isTerminalStatus(status: ClassroomPayload['status'] | undefined): status is TerminalClassSessionStatus {
    return status === 'completed' || status === 'cancelled';
  }

  private async refreshMediaDevices(): Promise<void> {
    if (this.refreshingDevices()) {
      return;
    }

    this.refreshingDevices.set(true);
    this.mediaError.set('');
    try {
      await this.deviceWebRtc.refreshDevices();
      this.syncSelectedDevices();
      this.mediaNotice.set('Device list refreshed.');
    } catch (error) {
      this.mediaError.set(this.mediaRecoveryError()?.message ?? (error instanceof Error ? error.message : 'Unable to refresh camera and microphone list.'));
    } finally {
      this.refreshingDevices.set(false);
    }
  }

  protected startSidebarResize(event: PointerEvent, sidebar: HTMLElement, handle: HTMLElement): void {
    if (this.chatCollapsed() || event.button !== 0) {
      return;
    }

    this.resizePointerId = event.pointerId;
    this.resizeHandle = handle;
    this.resizingSidebar.set(true);
    handle.setPointerCapture(event.pointerId);
    this.applySidebarResize(event, sidebar);
    event.preventDefault();
  }

  protected resizeSidebar(event: PointerEvent, sidebar: HTMLElement): void {
    if (this.resizePointerId !== event.pointerId) {
      return;
    }

    this.applySidebarResize(event, sidebar);
    event.preventDefault();
  }

  protected endSidebarResize(event: PointerEvent): void {
    if (this.resizePointerId !== event.pointerId) {
      return;
    }

    if (this.resizeHandle?.hasPointerCapture(event.pointerId)) {
      this.resizeHandle.releasePointerCapture(event.pointerId);
    }

    this.resizePointerId = null;
    this.resizeHandle = null;
    this.resizingSidebar.set(false);
  }

  protected resizeSidebarWithKeyboard(event: KeyboardEvent): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }

    const direction = event.key === 'ArrowUp' ? -5 : 5;
    this.sidebarSplitPercent.update((value) => this.clampSplitPercent(value + direction));
    event.preventDefault();
  }

  protected studentVideoStream(participantId: string): MediaStream | null {
    if (!this.isStudentParticipantId(participantId) || this.isParticipantMediaHidden(participantId)) {
      return null;
    }
    return this.webrtc.remoteStreams().find((remote) => remote.kind === 'video' && remote.participantId === participantId)?.stream ?? null;
  }

  protected participantMediaState(participantId: string): ParticipantMediaState {
    if (this.isParticipantMediaHidden(participantId)) {
      return 'local-hidden';
    }

    const room = this.store.room();
    const participant = room?.participants.find((item) => item.id === participantId);
    const participantProducers = room?.producers.filter((producer) => producer.participantId === participantId) ?? [];
    const hasLiveAudioProducer = participantProducers.some((producer) => producer.kind === 'audio' && producer.status === 'live');
    const hasPausedAudioProducer = participantProducers.some((producer) => producer.kind === 'audio' && producer.status === 'paused');
    const hasPausedVideoProducer = participantProducers.some((producer) => producer.kind === 'video' && producer.status === 'paused');
    if (hasPausedVideoProducer || participant?.videoEnabled === false) {
      return 'camera-off';
    }
    if (this.studentVideoStream(participantId)) {
      return 'video';
    }
    if (hasLiveAudioProducer) {
      return participant?.audioEnabled === false ? 'muted' : 'audio-only';
    }
    if (hasPausedAudioProducer) {
      return 'muted';
    }
    if (participant?.audioEnabled === false) {
      return 'muted';
    }
    return 'unavailable';
  }

  protected participantMediaLabel(participantId: string): string {
    switch (this.participantMediaState(participantId)) {
      case 'video':
        return 'Live camera';
      case 'audio-only':
        return 'Audio only';
      case 'muted':
        return 'Muted';
      case 'camera-off':
        return 'Camera off';
      case 'local-hidden':
        return 'Hidden locally';
      case 'unavailable':
        return this.store.room()?.participants.find((participant) => participant.id === participantId)?.connected === false ? 'Reconnecting' : 'No live media';
    }
  }

  protected isParticipantActionPending(participantId: string, action: ParticipantCardAction): boolean {
    return Boolean(this.pendingParticipantActions()[participantId]?.[action]);
  }

  protected hasPendingParticipantAction(participantId: string): boolean {
    return Object.values(this.pendingParticipantActions()[participantId] ?? {}).some(Boolean);
  }

  protected isParticipantMediaHidden(participantId: string): boolean {
    return this.locallyHiddenParticipantIds().includes(participantId);
  }

  protected isParticipantMicMuted(participantId: string): boolean {
    const room = this.store.room();
    const participant = room?.participants.find((item) => item.id === participantId);
    const audioProducers = this.studentMediaProducers(participantId, 'audio');
    return participant?.audioEnabled === false || audioProducers.some((producer) => producer.status === 'paused');
  }

  protected isParticipantMicTeacherDisabled(participantId: string): boolean {
    const participant = this.store.room()?.participants.find((item) => item.id === participantId);
    return participant?.permissions.canPublishAudio === false;
  }

  protected isParticipantCameraStopped(participantId: string): boolean {
    const room = this.store.room();
    const participant = room?.participants.find((item) => item.id === participantId);
    const videoProducers = this.studentMediaProducers(participantId, 'video');
    return participant?.videoEnabled === false || videoProducers.some((producer) => producer.status === 'paused');
  }

  protected isParticipantCameraTeacherDisabled(participantId: string): boolean {
    const participant = this.store.room()?.participants.find((item) => item.id === participantId);
    return participant?.permissions.canPublishVideo === false;
  }

  protected hasLiveStudentCamera(participantId: string): boolean {
    return this.studentMediaProducers(participantId, 'video').some((producer) => producer.status === 'live');
  }

  protected hasLiveStudentMedia(participantId: string): boolean {
    return this.studentMediaProducers(participantId).some((producer) => producer.status === 'live');
  }

  protected participantRoleLabel(participant: SessionParticipant): string {
    if (participant.role === 'Teacher') {
      return 'Host';
    }
    return participant.role;
  }

  protected whiteboardPermissionLabel(permissionLevel: WhiteboardPermissionLevel): string {
    return WHITEBOARD_PERMISSION_OPTIONS.find((option) => option.value === permissionLevel)?.label ?? 'Annotate';
  }

  private canModerateParticipant(participantId: string): boolean {
    return this.participants().some((participant) => participant.id === participantId && participant.canModerate);
  }

  private setParticipantActionPending(participantId: string, action: ParticipantCardAction, pending: boolean): void {
    this.pendingParticipantActions.update((state) => {
      const nextActionState: ParticipantActionState = { ...(state[participantId] ?? {}) };
      if (pending) {
        nextActionState[action] = true;
      } else {
        delete nextActionState[action];
      }

      const nextState = { ...state };
      if (Object.values(nextActionState).some(Boolean)) {
        nextState[participantId] = nextActionState;
      } else {
        delete nextState[participantId];
      }
      return nextState;
    });
  }

  private setAllStudentActionPending(action: ParticipantCardAction, pending: boolean): void {
    for (const participant of this.studentControlTargets()) {
      this.setParticipantActionPending(participant.id, action, pending);
    }
  }

  private setParticipantMediaHidden(participantId: string, hidden: boolean): void {
    this.locallyHiddenParticipantIds.update((participantIds) => {
      if (hidden) {
        return participantIds.includes(participantId) ? participantIds : [...participantIds, participantId];
      }
      return participantIds.filter((id) => id !== participantId);
    });
  }

  private applyClassModerationResult(response: ClassStudentMediaModerationResponse): void {
    for (const event of response.events) {
      this.applyStudentModerationResult(event);
    }
  }

  private applyStudentModerationResult(event: StudentMediaModerationEvent): void {
    if (event.permissions) {
      this.store.patchParticipant(event.participantId, { permissions: event.permissions } as Partial<Participant>);
    }
    if (event.action === 'mute-mic' || event.action === 'stop-camera') {
      const participantPatch: Partial<Participant> = event.kind === 'audio' ? { audioEnabled: false } : { videoEnabled: false };
      this.store.patchParticipant(event.participantId, participantPatch);
    }
    if (event.producerId) {
      const producer = this.store.room()?.producers.find((item) => item.id === event.producerId);
      if (producer) {
        this.store.upsertProducer({ ...producer, status: 'paused' });
      }
      this.cleanupStudentProducer(event.producerId);
    }
    this.updateParticipant(event.participantId, (participant) =>
      event.action === 'mute-mic'
        ? { ...participant, muted: true }
        : event.action === 'stop-camera'
          ? { ...participant, cameraOff: true }
          : participant
    );
    this.syncParticipantsFromRoom();
  }

  private applyStudentSpeakResult(event: ClassStudentSpeakEvent): void {
    this.applyParticipantPatch(event.participantId, {
      handRaised: event.allowedToSpeak ? false : undefined,
      handRaisedAt: event.allowedToSpeak ? null : undefined,
      allowedToSpeak: event.allowedToSpeak,
      allowedToSpeakAt: 'allowedToSpeakAt' in event && typeof event.allowedToSpeakAt === 'string' ? event.allowedToSpeakAt : null,
      allowedToSpeakBy: 'allowedToSpeakBy' in event && typeof event.allowedToSpeakBy === 'string' ? event.allowedToSpeakBy : null,
      permissions: 'permissions' in event && event.permissions ? event.permissions : undefined
    });
  }

  private applyParticipantPatch(participantId: string, patch: ParticipantPatch): void {
    const cleanedPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as ParticipantPatch;
    this.store.patchParticipant(participantId, cleanedPatch as Partial<Participant>);
    this.updateParticipant(participantId, (participant) => ({
      ...participant,
      handRaised: cleanedPatch.handRaised ?? participant.handRaised,
      handRaisedAt: cleanedPatch.handRaisedAt === null ? undefined : (cleanedPatch.handRaisedAt ?? participant.handRaisedAt),
      allowedToSpeak: cleanedPatch.allowedToSpeak ?? participant.allowedToSpeak,
      allowedToSpeakAt: cleanedPatch.allowedToSpeakAt === null ? undefined : (cleanedPatch.allowedToSpeakAt ?? participant.allowedToSpeakAt),
      muted: cleanedPatch.allowedToSpeak === true ? false : cleanedPatch.allowedToSpeak === false ? true : participant.muted
    }));
    this.syncParticipantsFromRoom();
  }

  private applyWhiteboardControlEvent(event: WhiteboardControlEvent): void {
    if (!this.isCurrentRoom(event.roomId)) {
      return;
    }
    if (event.granted) {
      const permissionLevel = event.permissionLevel ?? 'annotate';
      this.whiteboardControllerParticipantId.set(event.participantId);
      this.whiteboardControllerName.set(event.displayName ?? this.participants().find((participant) => participant.id === event.participantId)?.name ?? 'Student');
      this.whiteboardControllerPermissionLevel.set(permissionLevel);
      this.whiteboardControllerPageId.set(event.pageId ?? '');
      this.clearWhiteboardCursors();
      this.startStudentWhiteboardAttempt(event);
      return;
    }
    if (!this.whiteboardControllerParticipantId() || this.whiteboardControllerParticipantId() === event.participantId) {
      this.finishStudentWhiteboardAttempt(event.participantId, 'revoked');
      this.clearWhiteboardControlState();
    }
  }

  private applyWhiteboardLockEvent(event: WhiteboardLockEvent): void {
    if (!this.isCurrentRoom(event.roomId)) {
      return;
    }
    this.whiteboardLocked.set(event.locked);
    if (event.locked) {
      this.clearWhiteboardCursors();
    }
  }

  private scheduleWhiteboardMemoryLoad(payload: ClassroomPayload, force = false): void {
    window.setTimeout(() => this.loadWhiteboardMemory(payload, force));
  }

  private loadWhiteboardMemory(payload: ClassroomPayload, force = false): void {
    if (this.destroyed || this.privatePreparation() || payload.status !== 'live' || (!force && this.whiteboardMemoryLoadedSessionId === payload.sessionId)) {
      return;
    }
    if (!this.whiteboard) {
      window.setTimeout(() => this.loadWhiteboardMemory(payload, force), 50);
      return;
    }
    this.whiteboardMemoryLoadedSessionId = payload.sessionId;
    const loadRevision = this.whiteboardEditRevision;
    const requestId = ++this.whiteboardMemoryRequestId;
    this.whiteboardMemoryReady = false;
    this.whiteboardMemoryLoadEvents ??= [];
    this.whiteboardMemorySaveState.set('loading');
    this.classSessions.getWhiteboardMemory(payload.sessionId, { batchId: payload.batchId }).subscribe({
      next: (state) => {
        if (this.destroyed || requestId !== this.whiteboardMemoryRequestId) return;
        this.whiteboardMemoryReady = true;
        if (this.whiteboardEditRevision !== loadRevision) {
          this.whiteboardMemoryLoadEvents = null;
          this.whiteboardSaveConflict.set(true);
          this.whiteboardMemorySaveState.set('failed');
          this.whiteboardMemoryNotice.set('The board changed while loading. Download your local backup, then reload the saved board.');
          return;
        }
        if (state) {
          this.applyWhiteboardMemoryState(state);
          void this.checkLocalDraft();
          const received = this.whiteboardMemoryLoadEvents ?? [];
          this.whiteboardMemoryLoadEvents = null;
          const ordered = received.sort((a, b) => (a.operationSeq ?? 0) - (b.operationSeq ?? 0));
          for (let index = 0; index < ordered.length; index += 1) {
            const event = ordered[index]!;
            const lastSeq = this.whiteboardMemoryState()?.lastOperationSeq ?? 0;
            if (event.operationSeq && event.operationSeq <= lastSeq) continue;
            if (event.operationSeq && event.operationSeq !== lastSeq + 1) {
              this.whiteboardMemoryLoadEvents = ordered.slice(index);
              this.loadWhiteboardMemory(payload, true);
              return;
            }
            this.applyRemoteWhiteboardCommand(event);
          }
        } else {
          this.whiteboardMemoryLoadEvents = null;
          this.whiteboardMemoryState.set(null);
          this.whiteboardMemorySaveState.set('idle');
          const roomId = this.currentRoomId();
          void this.checkLocalDraft().then((recovered) => { if (roomId && !recovered) void this.sendWhiteboardSnapshot(roomId); });
        }
      },
      error: (error) => {
        if (requestId !== this.whiteboardMemoryRequestId) return;
        this.whiteboardMemoryLoadEvents = null;
        this.whiteboardMemoryLoadedSessionId = '';
        this.whiteboardMemorySaveState.set('failed');
        this.whiteboardMemoryNotice.set(this.classSessions.errorMessage(error));
      }
    });
  }

  private async reloadWhiteboardAfterReconnect(payload: ClassroomPayload): Promise<void> {
    await this.whiteboardSyncTail;
    if (this.destroyed || !this.roomJoined()) return;
    if (this.whiteboardSaveConflict()) {
      this.whiteboardMemoryLoadEvents = null;
      return;
    }
    this.loadWhiteboardMemory(payload, true);
  }

  private applyWhiteboardMemoryState(state: WhiteboardMemoryState): void {
    const whiteboard = this.whiteboard;
    this.whiteboardMemoryState.set(state);
    this.whiteboardMemoryReady = true;
    this.whiteboardSaveConflict.set(false);
    if (!whiteboard) {
      this.whiteboardMemorySaveState.set('saved');
      return;
    }
    this.whiteboardMemoryApplying = true;
    try {
      whiteboard.importBoardState(state.snapshot);
      whiteboard.requestCaptureFrame();
      this.whiteboardMemorySaveState.set('saved');
    } finally {
      this.whiteboardMemoryApplying = false;
    }
  }

  private localDraftKey(): string { return `board:${this.auth.user()?.id ?? ''}:${this.session()?.sessionId ?? ''}`; }

  private async persistLocalDraft(): Promise<void> {
    if (!this.whiteboard || !this.session() || this.whiteboardMemoryApplying || !this.auth.user()?.id) return;
    try { await this.recoveryStore.put(this.localDraftKey(), { snapshot: this.whiteboard.exportBoardState(), savedAt: new Date().toISOString() }); }
    catch { this.whiteboardMemoryNotice.set('Local backup could not be saved. Keep this window open until the board synchronizes.'); }
  }

  private async checkLocalDraft(): Promise<boolean> {
    const draft = await this.recoveryStore.get<{ snapshot: ReturnType<Whiteboard['exportBoardState']>; savedAt: string }>(this.localDraftKey()).catch(() => undefined);
    if (draft && JSON.stringify(draft.snapshot) !== JSON.stringify(this.whiteboard?.exportBoardState())) { this.localDraft.set(draft); return true; }
    return false;
  }

  protected async restoreLocalDraft(): Promise<void> {
    const draft = this.localDraft();
    if (!draft || !this.whiteboard || !this.session()) return;
    this.whiteboard.importBoardState(draft.snapshot);
    this.whiteboardSaveConflict.set(false);
    this.whiteboardEditRevision++;
    this.localDraft.set(null);
    try {
      if (!this.whiteboardMemoryReady) {
        const session = this.session()!;
        const baseline = await firstValueFrom(this.classSessions.getWhiteboardMemory(session.sessionId, { batchId: session.batchId }));
        this.whiteboardMemoryState.set(baseline);
        this.whiteboardMemoryReady = true;
      }
      const saved = await this.saveWhiteboardMemory('autosave', false);
      if (!saved) throw new Error('Board is not ready to save.');
      const roomId = this.currentRoomId();
      if (roomId) await this.socket.emitAck('whiteboard:refresh', { roomId });
      this.whiteboardMemoryNotice.set('Recovered local lesson work.');
    } catch { this.localDraft.set(draft); this.whiteboardSaveConflict.set(true); this.whiteboardMemoryNotice.set('Recovered work is still on this device. Reconnect and restore the draft again to save it.'); }
  }

  protected async discardLocalDraft(): Promise<void> {
    await this.recoveryStore.remove(this.localDraftKey()); this.localDraft.set(null);
  }

  private scheduleWhiteboardAutosave(): void {
    if (!this.whiteboardMemoryApplying && !this.localDraftTimer) this.localDraftTimer = setTimeout(() => {
      this.localDraftTimer = undefined; void this.persistLocalDraft();
    }, 300);
    if (this.whiteboardMemoryApplying || this.whiteboardSaveConflict() || !this.sessionLive() || this.ending() || !this.whiteboard) {
      return;
    }
    this.whiteboardMemorySaveState.set('pending');
    this.clearWhiteboardAutosaveTimer();
    this.whiteboardAutosaveTimer = window.setTimeout(() => {
      this.whiteboardAutosaveTimer = undefined;
      void this.saveWhiteboardMemory('autosave', false).catch(() => null);
    }, 1_500);
  }

  private clearWhiteboardAutosaveTimer(): void {
    if (!this.whiteboardAutosaveTimer) {
      return;
    }
    window.clearTimeout(this.whiteboardAutosaveTimer);
    this.whiteboardAutosaveTimer = undefined;
  }

  private whiteboardSaveGuard(): { expectedSnapshotVersion: number; expectedLastOperationSeq: number } {
    const state = this.whiteboardMemoryState();
    return { expectedSnapshotVersion: state?.snapshotVersion ?? 0, expectedLastOperationSeq: state?.lastOperationSeq ?? 0 };
  }

  private saveWhiteboardMemory(reason: WhiteboardMemorySaveReason = 'autosave', createVersion = false): Promise<WhiteboardMemoryState | null> {
    const save = this.whiteboardSyncTail.then(async () => {
      const session = this.session();
      if (!session || !this.whiteboard || this.whiteboardMemoryApplying || !this.whiteboardMemoryReady || this.whiteboardSaveConflict()) return null;
      const snapshot = this.whiteboard.exportBoardState();
      const revision = this.whiteboardEditRevision;
      const guard = this.whiteboardSaveGuard();
      this.whiteboardMemorySaveState.set('saving');
      try {
        const state = await new Promise<WhiteboardMemoryState>((resolve, reject) => this.classSessions.saveWhiteboardMemory(session.sessionId, {
          batchId: session.batchId, snapshot, reason, createVersion, ...guard
        }).subscribe({ next: resolve, error: reject }));
        if (!this.whiteboardMemoryState() || state.snapshotVersion >= this.whiteboardMemoryState()!.snapshotVersion) this.whiteboardMemoryState.set(state);
        this.whiteboardMemorySaveState.set(revision === this.whiteboardEditRevision ? 'saved' : 'pending');
        if (revision === this.whiteboardEditRevision) { if (this.localDraftTimer) clearTimeout(this.localDraftTimer); this.localDraftTimer = undefined; await this.recoveryStore.remove(this.localDraftKey()).catch(() => undefined); }
        if (reason !== 'autosave') this.whiteboardMemoryNotice.set('Board memory saved.');
        return state;
      } catch (error) {
        this.whiteboardMemorySaveState.set('failed');
        if ((error as { status?: number })?.status === 409) {
          this.whiteboardSaveConflict.set(true);
          this.whiteboardMemoryNotice.set('The saved board changed while saving. Your local board is preserved. Download a backup, then reload the saved board to continue.');
        } else this.whiteboardMemoryNotice.set(this.classSessions.errorMessage(error));
        throw error;
      }
    });
    this.whiteboardSyncTail = save.then(() => undefined, () => undefined);
    return save;
  }

  private updateWhiteboardRevision(event: WhiteboardCommandEvent): boolean {
    if (event.snapshotVersion === undefined || event.operationSeq === undefined) {
      if (event.idempotentReplay) {
        this.whiteboardSaveConflict.set(true);
        this.whiteboardMemoryNotice.set('A retried board change was saved. Reload the saved board before saving a full snapshot; a local backup is available.');
      }
      return false;
    }
    const lastSeq = this.whiteboardMemoryState()?.lastOperationSeq ?? 0;
    if (event.operationSeq <= lastSeq) return false;
    if (event.operationSeq !== lastSeq + 1) {
      this.whiteboardSaveConflict.set(true);
      this.whiteboardMemoryNotice.set('Some board updates arrived out of order. Your local board is preserved. Reload the saved board before continuing.');
      return false;
    }
    const session = this.session();
    const snapshot = this.whiteboard?.exportBoardState();
    if (!session || !snapshot) return false;
    this.whiteboardMemoryState.update((state) => {
      if (state && event.snapshotVersion! < state.snapshotVersion) return state;
      const now = new Date().toISOString();
      return { ...state, sessionId: session.sessionId, batchId: session.batchId, roomId: session.roomId,
        whiteboardChannelId: session.whiteboardChannelId, schemaVersion: 1,
        snapshotVersion: event.snapshotVersion!, lastOperationSeq: event.operationSeq!, lastOperationId: event.operationId,
        snapshot: state?.snapshot ?? snapshot, summary: state?.summary ?? { pages: [], pageCount: snapshot.pages.length, elementCount: 0 },
        createdAt: state?.createdAt ?? now, updatedAt: now };
    });
    return true;
  }

  protected downloadLocalWhiteboardBackup(): void {
    const snapshot = this.whiteboard?.exportBoardState();
    if (snapshot) this.saveBlob(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }), 'whiteboard-local-backup.json');
  }

  protected reloadSavedWhiteboard(): void {
    const session = this.session();
    if (!session || this.whiteboardMemoryBusy()) return;
    this.downloadLocalWhiteboardBackup();
    this.whiteboardMemoryBusy.set(true);
    const revision = this.whiteboardEditRevision;
    void this.whiteboardSyncTail.then(() => this.classSessions.getWhiteboardMemory(session.sessionId, { batchId: session.batchId }).subscribe({
      next: (state) => {
        if (revision !== this.whiteboardEditRevision) { this.whiteboardMemoryNotice.set('The board changed while reloading. Your local board was kept; try reloading again.'); }
        else if (state) this.applyWhiteboardMemoryState(state);
        else this.whiteboardMemoryNotice.set('No saved board is available. Your local board was kept.');
        this.whiteboardMemoryBusy.set(false);
      },
      error: (error) => { this.whiteboardMemoryNotice.set(this.classSessions.errorMessage(error)); this.whiteboardMemoryBusy.set(false); }
    }));
  }

  private applyRemoteWhiteboardCommand(event: WhiteboardCommandEvent): void {
    if (!this.isCurrentRoom(event.roomId) || event.participantId === this.store.localParticipantId()) {
      return;
    }
    if (this.whiteboardMemoryLoadEvents) {
      this.whiteboardMemoryLoadEvents.push(event);
      return;
    }
    if (!this.updateWhiteboardRevision(event)) return;
    this.whiteboardEditRevision += 1;
    const command = this.normalizeWhiteboardCommand(event.command);
    this.trackStudentWhiteboardCommand(event.participantId, command);
    this.whiteboard?.applyCommand(command);
    this.whiteboard?.requestCaptureFrame();
    this.scheduleWhiteboardAutosave();
  }

  private applyRemoteWhiteboardCursor(event: WhiteboardCursorEvent): void {
    if (!this.isCurrentRoom(event.roomId) || event.cursor.participantId === this.store.localParticipantId()) {
      return;
    }
    this.studentCursors.update((cursors) => [
      ...cursors.filter((cursor) => cursor.participantId !== event.cursor.participantId),
      event.cursor
    ]);
    const previousTimer = this.whiteboardCursorTimers.get(event.cursor.participantId);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }
    const timer = setTimeout(() => {
      this.studentCursors.update((cursors) => cursors.filter((cursor) => cursor.participantId !== event.cursor.participantId));
      this.whiteboardCursorTimers.delete(event.cursor.participantId);
    }, 1800);
    this.whiteboardCursorTimers.set(event.cursor.participantId, timer);
  }

  private async sendWhiteboardSnapshot(roomId: string): Promise<void> {
    if (roomId !== this.currentRoomId()) return;
    for (const command of this.whiteboard?.snapshotCommands() ?? []) this.handleTeacherWhiteboardCommand(command);
    await this.whiteboardSyncTail;
  }

  private normalizeWhiteboardCommand(command: WhiteboardCommand | WireWhiteboardCommand): WhiteboardCommand {
    if (command.type === 'clear') {
      return { type: 'clear', ...(command.pageId ? { pageId: command.pageId } : {}) };
    }
    if (command.type === 'delete') {
      return { type: 'delete', elementId: command.elementId, ...(command.pageId ? { pageId: command.pageId } : {}) };
    }
    if (command.type === 'page-upsert' || command.type === 'page-delete' || command.type === 'page-select') return command as WhiteboardCommand;
    return { type: 'upsert', ...(command.elementIndex !== undefined ? { elementIndex: command.elementIndex } : {}), element: command.element as LocalWhiteboardUpsertElement, ...(command.pageId ? { pageId: command.pageId } : {}) };
  }

  private toWireWhiteboardCommand(command: WhiteboardCommand): WireWhiteboardCommand {
    return this.normalizeWhiteboardCommand(command) as unknown as WireWhiteboardCommand;
  }

  private createWhiteboardOperationId(): string {
    const random = globalThis.crypto?.randomUUID?.();
    return random || `wb-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private clearWhiteboardControlState(): void {
    this.whiteboardControllerParticipantId.set('');
    this.whiteboardControllerName.set('');
    this.whiteboardControllerPermissionLevel.set('view_only');
    this.whiteboardControllerPageId.set('');
    this.clearWhiteboardCursors();
  }

  private startStudentWhiteboardAttempt(event: WhiteboardControlEvent): void {
    const studentName = event.displayName ?? this.participants().find((participant) => participant.id === event.participantId)?.name ?? 'Student';
    const current = this.studentWhiteboardAttempt();
    if (event.grantedAt && current?.grantedAt === event.grantedAt) {
      // A rejoin replays the existing grant, including its original attempt.
      const resumed = current.status === 'revoked';
      this.studentWhiteboardAttempt.set({
        ...current,
        participantId: event.participantId,
        studentName,
        permissionLevel: event.permissionLevel ?? current.permissionLevel,
        pageId: event.pageId,
        ...(resumed ? { status: 'active', endedAt: undefined } : {})
      });
      return;
    }
    this.studentWhiteboardAttempt.set({
      attemptId: `${event.participantId}-${Date.now()}`,
      participantId: event.participantId,
      studentName,
      permissionLevel: event.permissionLevel ?? 'annotate',
      ...(event.pageId ? { pageId: event.pageId } : {}),
      startedAt: event.grantedAt ?? new Date().toISOString(),
      ...(event.grantedAt ? { grantedAt: event.grantedAt } : {}),
      status: 'active',
      baselineKeys: (this.whiteboard?.elementRefs() ?? []).map((ref) => this.whiteboardElementRefKey(ref)),
      elementRefs: []
    });
  }

  private finishStudentWhiteboardAttempt(participantId: string, status: StudentWhiteboardAttempt['status']): void {
    const attempt = this.studentWhiteboardAttempt();
    if (!attempt || attempt.participantId !== participantId || attempt.status !== 'active') {
      return;
    }
    this.studentWhiteboardAttempt.set({
      ...attempt,
      status,
      endedAt: new Date().toISOString()
    });
  }

  private trackStudentWhiteboardCommand(participantId: string, command: WhiteboardCommand): void {
    const attempt = this.studentWhiteboardAttempt();
    if (!attempt || attempt.participantId !== participantId || attempt.status !== 'active') {
      return;
    }
    if (command.type === 'clear') {
      return;
    }
    if (command.type === 'delete') {
      this.studentWhiteboardAttempt.set({
        ...attempt,
        elementRefs: attempt.elementRefs.filter((ref) => ref.elementId !== command.elementId)
      });
      return;
    }
    if (command.type !== 'upsert') return;
    const ref: WhiteboardElementRef = { elementId: command.element.id, ...(command.pageId ? { pageId: command.pageId } : {}) };
    const key = this.whiteboardElementRefKey(ref);
    if (attempt.baselineKeys.includes(key) || attempt.elementRefs.some((item) => this.whiteboardElementRefKey(item) === key)) {
      return;
    }
    this.studentWhiteboardAttempt.set({
      ...attempt,
      elementRefs: [...attempt.elementRefs, ref]
    });
  }

  private whiteboardElementRefKey(ref: WhiteboardElementRef): string {
    return `${ref.pageId ?? '*'}:${ref.elementId}`;
  }

  private safeFileSegment(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 48) || 'student';
  }

  private clearWhiteboardCursors(): void {
    for (const timer of this.whiteboardCursorTimers.values()) {
      clearTimeout(timer);
    }
    this.whiteboardCursorTimers.clear();
    this.studentCursors.set([]);
  }

  private saveBlob(blob: Blob, fileName: string): void {
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
  }

  private applyRecording(recording: Recording): void {
    this.session.update((session) => {
      if (!session || recording.sessionId !== session.sessionId) {
        return session;
      }
      return {
        ...session,
        activeRecording: this.isActiveRecording(recording) ? recording : undefined,
        latestRecording: recording
      };
    });
  }

  private applyRecordingEvent(event: ClassSessionRecordingEvent): void {
    const session = this.session();
    if (!session || event.sessionId !== session.sessionId) {
      return;
    }
    this.applyRecording(event.recording);
    const recordingId = event.recording.recordingId ?? event.recording.id;
    if ((event.status === 'stopped' || event.status === 'failed') && recordingId === this.lessonRecorder.activeId()) {
      void this.lessonRecorder.stop().catch(() => this.mediaNotice.set('Captured lesson media is saved on this device and waiting to upload.'));
    }
    if (event.status === 'recording') void this.ensureLessonCapture(event.recording);
    if (event.status === 'recording') {
      this.mediaNotice.set('Recording started.');
    } else if (event.status === 'stopped') {
      this.mediaNotice.set('Recording stopped.');
    } else if (event.status === 'failed') {
      this.mediaError.set(event.reason || event.recording.failureReason || 'Recording failed.');
    }
  }

  private isActiveRecording(recording: Recording | null | undefined): boolean {
    return recording?.status === 'starting' || recording?.status === 'recording' || recording?.status === 'stopping';
  }

  protected recordingExpired(recording: Recording | null | undefined): boolean {
    const expiresAt = recording?.retentionExpiresAt;
    if (!expiresAt) {
      return false;
    }
    const timestamp = Date.parse(expiresAt);
    return Number.isFinite(timestamp) && timestamp <= Date.now();
  }

  private watchSession(sessionId: string, batchId?: string, force = false): void {
    if (!sessionId || (this.watchedSessionId === sessionId && !force)) {
      return;
    }
    const previousSessionId = this.watchedSessionId;
    this.watchedSessionId = sessionId;
    if (previousSessionId && previousSessionId !== sessionId && this.realtimeSocket.connected) {
      void this.socket.emitAck('session:unwatch', { sessionId: previousSessionId }).catch(() => undefined);
    }
    if (!this.realtimeSocket.connected) {
      return;
    }
    void this.socket.emitAck('session:watch', { sessionId, ...(batchId ? { batchId } : {}) }).catch(() => undefined);
  }

  private handleClassSessionEnded(event: ClassSessionLifecycleEvent): void {
    const current = this.session();
    if (!current || event.sessionId !== current.sessionId) {
      return;
    }
    if (event.roomId && current.roomId && event.roomId !== current.roomId) {
      return;
    }
    if (this.terminalSessionHandled && this.isTerminalStatus(current.status)) {
      return;
    }
    this.mediaError.set('This class session has ended.');
    this.markSessionTerminal('completed', event.completedAt);
    void this.leaveCurrentRoom();
  }

  private unwatchSession(): void {
    const sessionId = this.watchedSessionId;
    this.watchedSessionId = '';
    if (!sessionId || !this.realtimeSocket.connected) {
      return;
    }
    void this.socket.emitAck('session:unwatch', { sessionId }).catch(() => undefined);
  }

  private updateParticipant(participantId: string, update: (participant: SessionParticipant) => SessionParticipant): void {
    this.participants.update((participants) =>
      participants.map((participant) => (participant.id === participantId ? update(participant) : participant))
    );
  }

  private bindSocketEvents(): void {
    this.bindSocketLifecycle();
    this.registerSocketHandler('session:ended', (event) => this.handleClassSessionEnded(event));
    this.registerSocketHandler('whiteboard:control-granted', (event) => this.applyWhiteboardControlEvent(event));
    this.registerSocketHandler('whiteboard:control-revoked', (event) => this.applyWhiteboardControlEvent(event));
    this.registerSocketHandler('whiteboard:lock-changed', (event) => this.applyWhiteboardLockEvent(event));
    this.registerSocketHandler('whiteboard:refresh', (event) => {
      if (!this.isCurrentRoom(event.roomId) || event.participantId === this.store.localParticipantId()) return;
      this.whiteboardSaveConflict.set(true);
      this.whiteboardMemoryNotice.set('Another teacher restored the saved board. Your local board is preserved; reload it to continue.');
    });
    this.registerSocketHandler('whiteboard:command', (event) => this.applyRemoteWhiteboardCommand(event));
    this.registerSocketHandler('whiteboard:cursor', (event) => this.applyRemoteWhiteboardCursor(event));
    this.registerSocketHandler('room:updated', (room) => {
      if (!this.isCurrentRoom(room.id)) {
        return;
      }
      this.cleanupRemovedRoomProducers(room);
      this.store.setRoom(room);
      this.syncParticipantsFromRoom();
      void this.consumeAvailableStudentProducers();
    });
    this.registerSocketHandler('participant:joined', (participant) => {
      if (!this.isCurrentRoom(this.store.room()?.id)) {
        return;
      }
      this.store.upsertParticipant(participant);
      this.syncParticipantsFromRoom();
      void this.consumeAvailableStudentProducers();
    });
    this.registerSocketHandler('participant:left', (participantId) => {
      if (!this.isCurrentRoom(this.store.room()?.id)) {
        return;
      }
      this.cleanupStudentParticipantMedia(participantId);
      this.clearParticipantCardState(participantId);
      if (this.whiteboardControllerParticipantId() === participantId) {
        this.clearWhiteboardControlState();
      }
      this.store.removeParticipant(participantId);
      this.syncParticipantsFromRoom();
    });
    this.registerSocketHandler('participant:updated', (participantId, patch) => {
      if (!this.isCurrentRoom(this.store.room()?.id)) {
        return;
      }
      this.store.patchParticipant(participantId, patch as Partial<Participant>);
      this.syncParticipantsFromRoom();
      void this.consumeAvailableStudentProducers();
    });
    this.registerSocketHandler('permissions:updated', (participantId, permissions) => {
      if (!this.isCurrentRoom(this.store.room()?.id)) {
        return;
      }
      this.store.patchParticipant(participantId, { permissions } as Partial<Participant>);
      this.syncParticipantsFromRoom();
    });
    this.registerSocketHandler('producer:created', (producer) => {
      if (!this.isCurrentRoom(producer.roomId)) {
        return;
      }
      this.store.upsertProducer(producer);
      this.syncParticipantsFromRoom();
      void this.consumeStudentProducer(producer);
    });
    this.registerSocketHandler('producer:updated', (producer) => {
      if (!this.isCurrentRoom(producer.roomId)) {
        return;
      }
      this.store.upsertProducer(producer);
      if (producer.status === 'live') {
        void this.consumeStudentProducer(producer);
      } else {
        this.cleanupStudentProducer(producer.id);
      }
      this.syncParticipantsFromRoom();
    });
    this.registerSocketHandler('producer:closed', (producerId) => {
      if (producerId === this.screenProducerId) {
        this.localProducerIds.delete(producerId);
        if (!this.replacingScreenSource) {
          this.screenProducerId = '';
          this.webrtc.releaseLocalProducer(producerId);
          this.clearWhiteboardShareState();
          this.webrtc.stopScreen();
          this.whiteboardSourceChoice.set('classroom');
        }
      }
      this.cleanupStudentProducer(producerId);
      this.store.removeProducer(producerId);
      this.syncParticipantsFromRoom();
    });
    this.registerSocketHandler('producer:layers-needed', (event) => {
      this.store.applyProducerDynacast(event);
      void this.webrtc.applyProducerDynacast(event);
    });
    this.registerSocketHandler('producer:layers-unneeded', (event) => {
      this.store.applyProducerDynacast(event);
      void this.webrtc.applyProducerDynacast(event);
    });
    this.registerSocketHandler('producer:dynacast-updated', (event) => this.store.applyProducerDynacast(event));
    this.registerSocketHandler('producer:score-updated', (state) => this.store.applyProducerQuality(state));
    this.registerSocketHandler('consumer:created', (consumer) => this.applyConsumerEvent(consumer));
    this.registerSocketHandler('consumer:updated', (consumer) => this.applyConsumerEvent(consumer));
    this.registerSocketHandler('consumer:closed', (consumerId) => {
      const room = this.store.room();
      const producerId = this.consumerProducerIds.get(consumerId) ?? room?.consumers.find((item) => item.id === consumerId)?.producerId;
      this.consumerProducerIds.delete(consumerId);
      this.removeConsumer(consumerId);
      if (producerId) {
        this.cleanupStudentProducer(producerId);
      }
    });
    this.registerSocketHandler('consumer:score-updated', (state) => {
      this.store.applyConsumerQuality(state);
      if (state.participantId === this.store.localParticipantId()) {
        this.webrtc.setNetworkQualityScore(state.score.score);
      }
    });
    this.registerSocketHandler('consumer:layers-changed', (event) => this.store.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:layers-switching', (event) => this.store.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:layers-unavailable', (event) => this.store.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:layers-switch-failed', (event) => this.store.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:svc-layers-changed', (event) => this.store.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:svc-layers-switching', (event) => this.store.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:svc-layers-unavailable', (event) => this.store.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:svc-layers-switch-failed', (event) => this.store.applyConsumerLayerEvent(event));
    this.registerSocketHandler('room:failed', (event) => this.mediaError.set(event.message));
    this.registerSocketHandler('recording:started', (event) => this.applyRecordingEvent(event));
    this.registerSocketHandler('recording:updated', (event) => this.applyRecordingEvent(event));
    this.registerSocketHandler('recording:stopped', (event) => this.applyRecordingEvent(event));
    this.registerSocketHandler('recording:failed', (event) => this.applyRecordingEvent(event));
    this.registerSocketHandler('room:closed', (roomId) => {
      if (this.isCurrentRoom(roomId) || roomId === this.session()?.roomId) {
        this.mediaError.set('This room has closed.');
        this.markSessionTerminal('completed');
        void this.leaveCurrentRoom();
      }
    });
    this.registerSocketHandler('participant:kicked', (reason) => {
      this.mediaError.set(reason ?? 'You were removed from the room.');
      void this.leaveCurrentRoom();
    });
    this.registerSocketHandler('participant:banned', (reason) => {
      this.mediaError.set(reason ?? 'You were banned from the room.');
      void this.leaveCurrentRoom();
    });
    this.registerSocketHandler('network:quality', (quality) => {
      if (quality.participantId === this.store.localParticipantId()) {
        this.webrtc.networkScore.set(quality.score);
      }
    });
  }

  private registerSocketHandler<K extends keyof ServerToClientEvents>(
    event: K,
    handler: (...args: Parameters<ServerToClientEvents[K]>) => void
  ): void {
    this.realtimeSocket.on(event, handler as never);
    this.socketDisposers.push(() => this.realtimeSocket.off(event, handler as never));
  }

  private bindSocketLifecycle(): void {
    const handleConnect = () => {
      this.preflightSocketReady.set(true);
      const session = this.session();
      if (session) {
        this.watchSession(session.sessionId, session.batchId, true);
      }
      if (!this.socketWasDisconnected) {
        return;
      }
      this.socketWasDisconnected = false;
      void this.restoreRoomAfterReconnect();
    };
    const handleDisconnect = () => {
      this.preflightSocketReady.set(false);
      this.socketWasDisconnected = true;
      this.handleSocketDisconnect();
    };
    const handleConnectError = (error: Error) => {
      this.preflightSocketReady.set(false);
      if (this.joinedRoomId && this.sessionLive()) {
        this.mediaError.set(error.message || 'Unable to reconnect to the live room.');
      }
    };

    this.realtimeSocket.on('connect', handleConnect);
    this.realtimeSocket.on('disconnect', handleDisconnect);
    this.realtimeSocket.on('connect_error', handleConnectError);
    this.socketDisposers.push(() => {
      this.realtimeSocket.off('connect', handleConnect);
      this.realtimeSocket.off('disconnect', handleDisconnect);
      this.realtimeSocket.off('connect_error', handleConnectError);
    });
  }

  private bindBrowserRecoveryEvents(): void {
    const handleOnline = () => this.requestBrowserRecovery('online');
    const handleOffline = () => {
      if (this.sessionLive()) {
        this.mediaError.set('You are offline. The live class will recover when the network returns.');
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        this.requestBrowserRecovery('visible');
      }
      this.noteUserActivity('visibility');
    };
    const handleActivity = () => this.noteUserActivity('user');
    const handleFocus = () => this.noteUserActivity('focus');
    const handleBlur = () => this.noteUserActivity('blur');
    this.registerBrowserEvent(window, 'online', handleOnline);
    this.registerBrowserEvent(window, 'offline', handleOffline);
    this.registerBrowserEvent(window, 'pageshow', handleOnline);
    this.registerBrowserEvent(window, 'focus', handleFocus);
    this.registerBrowserEvent(window, 'blur', handleBlur);
    this.registerBrowserEvent(document, 'pointerdown', handleActivity);
    this.registerBrowserEvent(document, 'keydown', handleActivity);
    this.registerBrowserEvent(document, 'touchstart', handleActivity);
    this.registerBrowserEvent(document, 'visibilitychange', handleVisibilityChange);
  }

  private registerBrowserEvent(target: EventTarget, event: string, handler: EventListener): void {
    target.addEventListener(event, handler);
    this.socketDisposers.push(() => target.removeEventListener(event, handler));
  }

  private startActivityHeartbeat(): void {
    if (this.activityHeartbeatTimer || !this.joinedRoomId) {
      return;
    }
    this.lastUserActivityAt = Date.now();
    void this.sendActivityHeartbeat('heartbeat', true);
    this.activityHeartbeatTimer = setInterval(() => void this.sendActivityHeartbeat('heartbeat'), 30_000);
  }

  private stopActivityHeartbeat(): void {
    if (!this.activityHeartbeatTimer) {
      return;
    }
    clearInterval(this.activityHeartbeatTimer);
    this.activityHeartbeatTimer = undefined;
  }

  private noteUserActivity(reason: 'user' | 'visibility' | 'focus' | 'blur'): void {
    this.lastUserActivityAt = Date.now();
    const force = reason !== 'user';
    if (force || Date.now() - this.lastActivitySentAt > 5_000) {
      void this.sendActivityHeartbeat(reason, force);
    }
  }

  private async sendActivityHeartbeat(
    reason: 'heartbeat' | 'user' | 'visibility' | 'focus' | 'blur',
    force = false
  ): Promise<void> {
    const roomId = this.joinedRoomId;
    if (this.destroyed || !roomId || !this.sessionLive() || (!force && Date.now() - this.lastActivitySentAt < 5_000)) {
      return;
    }
    const inactiveSettings = this.liveSettings()?.inactiveDetection;
    const thresholdMs = Math.max(1, inactiveSettings?.inactiveAfterMinutes ?? 10) * 60_000;
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const focused = typeof document === 'undefined' || document.hasFocus();
    const activeByTime = Date.now() - this.lastUserActivityAt < thresholdMs;
    const active = activeByTime && (visible || inactiveSettings?.countBackgroundTabAsInactive === false);
    this.lastActivitySentAt = Date.now();
    await this.socket
      .emitAck('class:activity', {
        roomId,
        active,
        visible,
        focused,
        reason
      })
      .catch(() => undefined);
  }

  private requestBrowserRecovery(reason: 'online' | 'visible'): void {
    if (this.destroyed || !this.session() || this.isBrowserOffline() || document.visibilityState === 'hidden') {
      return;
    }
    this.clearBrowserRecoveryTimer();
    this.browserRecoveryTimer = setTimeout(() => {
      this.browserRecoveryTimer = undefined;
      if (this.destroyed || this.isBrowserOffline()) {
        return;
      }
      if (this.sessionLive() && this.joinedRoomId && !this.roomJoined()) {
        this.mediaNotice.set(reason === 'online' ? 'Network restored. Rejoining the live room...' : 'Checking live room connection...');
        this.restoreRoomAfterReconnect();
        return;
      }
      const session = this.session();
      if (!session) {
        this.loadSession();
        return;
      }
      this.classSessions.getSession(session.sessionId, session.batchId).subscribe({
        next: (payload) => {
          this.applyPayload(payload);
          if (payload.status === 'live' && this.roomJoined()) {
            void this.consumeAvailableStudentProducers();
          }
        },
        error: (error) => this.mediaError.set(this.classSessions.errorMessage(error))
      });
    }, 600);
  }

  private clearBrowserRecoveryTimer(): void {
    if (!this.browserRecoveryTimer) {
      return;
    }
    clearTimeout(this.browserRecoveryTimer);
    this.browserRecoveryTimer = undefined;
  }

  private isBrowserOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  }

  private handleSocketDisconnect(): void {
    if (this.destroyed || !this.joinedRoomId || !this.sessionLive()) {
      return;
    }

    this.clearWhiteboardAutosaveTimer();
    this.whiteboardMemoryReady = false;
    this.whiteboardMemoryRequestId += 1;
    this.whiteboardLocked.set(false);
    this.whiteboardMemoryLoadEvents ??= [];
    if (!this.whiteboardSaveConflict()) this.whiteboardMemorySaveState.set('loading');
    const wasWhiteboardSharing = this.whiteboardSharing();
    const wasScreenSharing = Boolean(this.screenProducerId || this.screenSharing() || wasWhiteboardSharing);
    this.mediaError.set('Connection lost. Reconnecting to the live room...');
    if (wasScreenSharing) {
      this.mediaNotice.set(wasWhiteboardSharing ? 'Whiteboard sharing stopped. Start sharing again after reconnecting.' : 'Screen sharing stopped. Start sharing again after reconnecting.');
    }
    this.cleanupRoomMediaLocally();
    this.store.room.set(null);
    this.store.localParticipantId.set(null);
    this.syncParticipantsFromSession();
  }

  private restoreRoomAfterReconnect(): void {
    const session = this.session();
    if (this.destroyed || this.reconnectingRoom || !this.joinedRoomId || !session) {
      return;
    }

    this.reconnectingRoom = true;
    this.mediaNotice.set('Connection restored. Rejoining the live room...');
    this.classSessions.getSession(session.sessionId, session.batchId).subscribe({
      next: (payload) => {
        this.applyPayload(payload);
        if (payload.status === 'live' && payload.roomId) {
          void this.joinAndPublish(payload, { showLoading: false }).finally(() => { this.reconnectingRoom = false; });
          return;
        }
        this.reconnectingRoom = false;
        this.joinedRoomId = '';
        this.cleanupRoomMediaLocally();
        this.mediaError.set('This session is no longer live.');
      },
      error: (error) => {
        this.reconnectingRoom = false;
        this.mediaError.set(this.classSessions.errorMessage(error));
      }
    });
  }

  private waitForSocketConnection(): Promise<void> {
    if (this.realtimeSocket.connected) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error('Unable to connect to the live room. Check your connection and try again.'));
      }, 8_000);
      const handleConnect = () => {
        cleanup();
        resolve();
      };
      const handleConnectError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        this.realtimeSocket.off('connect', handleConnect);
        this.realtimeSocket.off('connect_error', handleConnectError);
      };

      this.realtimeSocket.once('connect', handleConnect);
      this.realtimeSocket.once('connect_error', handleConnectError);
    });
  }

  private syncParticipantsFromRoom(): void {
    const room = this.store.room();
    if (!room || room.id !== this.session()?.roomId) {
      return;
    }
    const sessionParticipants = this.session()?.participants ?? [];
    const roomUserIds = new Set(room.participants.map((participant) => participant.userId ?? participant.id));
    const participants = [
      ...room.participants.map((participant) => this.roomParticipantToCard(participant)),
      ...sessionParticipants
        .filter((participant) => participant.role === 'student' && !roomUserIds.has(participant.userId || participant.id))
        .map((participant) => this.classroomParticipantToCard(participant))
    ];
    this.participants.set(participants);
    this.pruneParticipantCardState(participants.map((participant) => participant.id));
  }

  private syncParticipantsFromSession(): void {
    const session = this.session();
    if (!session) {
      this.participants.set([]);
      this.pruneParticipantCardState([]);
      return;
    }
    const participants = session.participants.map((participant) => this.classroomParticipantToCard(participant));
    this.participants.set(participants);
    this.pruneParticipantCardState(participants.map((participant) => participant.id));
  }

  private classroomParticipantToCard(participant: ClassroomPayload['participants'][number]): SessionParticipant {
    const isStudent = participant.role === 'student';
    return {
      id: participant.id,
      name: participant.displayName,
      role: participant.role === 'student' ? 'Student' : participant.role === 'admin' ? 'Admin' : 'Teacher',
      isStudent,
      canModerate: false,
      initials: this.initials(participant.displayName),
      muted: false,
      cameraOff: false,
      screenSharing: false,
      handRaised: false,
      allowedToSpeak: false,
      connected: false,
      inactive: false
    };
  }

  private roomParticipantToCard(participant: Participant): SessionParticipant {
    const isStudent = participant.role === 'PARTICIPANT' && this.isStudentParticipantId(participant.id);
    return {
      id: participant.id,
      name: participant.displayName,
      role: this.roomParticipantRoleLabel(participant),
      isStudent,
      canModerate: isStudent,
      initials: this.initials(participant.displayName),
      muted: this.isParticipantMicMuted(participant.id),
      cameraOff: this.isParticipantCameraStopped(participant.id),
      screenSharing: participant.screenSharing,
      handRaised: participant.handRaised,
      handRaisedAt: participant.handRaisedAt,
      allowedToSpeak: Boolean(participant.allowedToSpeak),
      allowedToSpeakAt: participant.allowedToSpeakAt,
      connected: participant.connected !== false,
      inactive: Boolean(participant.inactive),
      inactiveSince: participant.inactiveSince
    };
  }

  private roomParticipantRoleLabel(participant: Participant): SessionParticipant['role'] {
    if (participant.role === 'HOST') {
      return 'Teacher';
    }
    if (participant.role === 'CO_HOST') {
      return 'Co-host';
    }
    if (participant.role === 'VIEWER') {
      return 'Viewer';
    }
    return 'Student';
  }

  private teacherDisplayName(payload: ClassroomPayload): string {
    return (
      this.auth.user()?.name ??
      payload.participants.find((participant) => participant.role === 'teacher')?.displayName ??
      'Teacher'
    );
  }

  private applyProducerPolicyNotice(producer: { policyDecision?: { action: string; message: string } }): void {
    if (producer.policyDecision && producer.policyDecision.action !== 'allow') {
      this.mediaError.set(producer.policyDecision.message);
    }
  }

  private applyConsumerEvent(consumer: Consumer): void {
    this.store.upsertConsumer(consumer);
    this.consumerProducerIds.set(consumer.id, consumer.producerId);
    if (consumer.status === 'closed') {
      this.removeConsumer(consumer.id);
      this.cleanupStudentProducer(consumer.producerId);
    }
  }

  private async consumeAvailableStudentProducers(): Promise<void> {
    const room = this.store.room();
    if (!room || !this.isCurrentRoom(room.id)) {
      return;
    }
    await Promise.all(room.producers.filter((producer) => this.isStudentMediaProducer(producer)).map((producer) => this.consumeStudentProducer(producer)));
  }

  private async consumeStudentParticipantMedia(participantId: string): Promise<void> {
    await Promise.all(
      this.studentMediaProducers(participantId)
        .filter((producer) => producer.status === 'live')
        .map((producer) => this.consumeStudentProducer(producer))
    );
  }

  private async consumeStudentProducer(producer: Producer): Promise<void> {
    if (!this.isStudentMediaProducer(producer) || (producer.kind !== 'screen' && this.isParticipantMediaHidden(producer.participantId))) {
      return;
    }
    if (this.consumedStudentProducerIds.has(producer.id) || this.pendingStudentProducerIds.has(producer.id)) {
      return;
    }
    this.pendingStudentProducerIds.add(producer.id);
    try {
      const consumer = await this.webrtc.consumeProducer(producer.roomId, producer);
      if (!this.isStudentMediaProducer(producer) || (producer.kind !== 'screen' && this.isParticipantMediaHidden(producer.participantId))) {
        this.cleanupStudentProducer(producer.id);
        return;
      }
      if (consumer) {
        this.consumerProducerIds.set(consumer.id, producer.id);
        this.store.upsertConsumer(consumer);
      }
      this.consumedStudentProducerIds.add(producer.id);
    } catch (error) {
      this.mediaError.set(this.mediaRecoveryError()?.message ?? (error instanceof Error ? error.message : 'Unable to connect student media.'));
    } finally {
      this.pendingStudentProducerIds.delete(producer.id);
    }
  }

  private isStudentMediaProducer(producer: Producer): boolean {
    if (producer.status !== 'live' || !this.isCurrentRoom(producer.roomId) || (producer.kind !== 'audio' && producer.kind !== 'video' && producer.kind !== 'screen')) {
      return false;
    }
    if (producer.participantId === this.store.localParticipantId() || producer.participantId === this.session()?.teacherId) {
      return false;
    }
    return this.isStudentParticipantId(producer.participantId);
  }

  private isStudentParticipantId(participantId: string): boolean {
    const participant = this.store.room()?.participants.find((item) => item.id === participantId);
    if (!participant) {
      return false;
    }
    if (participant.id === this.store.localParticipantId()) {
      return false;
    }
    if (participant.role === 'HOST' || participant.role === 'CO_HOST') {
      return false;
    }
    const teacherId = this.session()?.teacherId;
    return !teacherId || (participant.id !== teacherId && participant.userId !== teacherId);
  }

  private cleanupStudentParticipantMedia(participantId: string, preservePresentation = false): void {
    for (const producer of this.store.room()?.producers.filter((item) => item.participantId === participantId && (!preservePresentation || item.kind !== 'screen')) ?? []) {
      this.cleanupStudentProducer(producer.id);
    }
  }

  private clearParticipantCardState(participantId: string): void {
    this.setParticipantMediaHidden(participantId, false);
    this.pendingParticipantActions.update((state) => {
      if (!state[participantId]) {
        return state;
      }
      const nextState = { ...state };
      delete nextState[participantId];
      return nextState;
    });
  }

  private pruneParticipantCardState(participantIds: string[]): void {
    const activeParticipantIds = new Set(participantIds);
    this.locallyHiddenParticipantIds.update((hiddenIds) => hiddenIds.filter((id) => activeParticipantIds.has(id)));
    this.pendingParticipantActions.update((state) =>
      Object.fromEntries(Object.entries(state).filter(([participantId]) => activeParticipantIds.has(participantId)))
    );
  }

  private cleanupStudentProducer(producerId: string): void {
    this.webrtc.removeRemoteProducer(producerId);
    this.consumedStudentProducerIds.delete(producerId);
    this.pendingStudentProducerIds.delete(producerId);
    this.removeConsumersForProducer(producerId);
  }

  private removeConsumersForProducer(producerId: string): void {
    const room = this.store.room();
    if (!room) {
      return;
    }
    const removedConsumers = room.consumers.filter((consumer) => consumer.producerId === producerId);
    if (!removedConsumers.length) {
      return;
    }
    for (const consumer of removedConsumers) {
      this.consumerProducerIds.delete(consumer.id);
    }
    this.store.room.set({
      ...room,
      consumers: room.consumers.filter((consumer) => consumer.producerId !== producerId)
    });
  }

  private removeConsumer(consumerId: string): void {
    this.consumerProducerIds.delete(consumerId);
    const room = this.store.room();
    if (!room || !room.consumers.some((consumer) => consumer.id === consumerId)) {
      return;
    }
    this.store.room.set({
      ...room,
      consumers: room.consumers.filter((consumer) => consumer.id !== consumerId)
    });
  }

  private isCurrentRoom(roomId: string | null | undefined): boolean {
    if (!roomId) {
      return false;
    }
    return this.session()?.roomId === roomId || this.joinedRoomId === roomId;
  }

  private currentRoomId(): string | null {
    return this.joinedRoomId || this.store.room()?.id || this.session()?.roomId || null;
  }

  private studentMediaProducers(participantId: string, kind?: Extract<Producer['kind'], 'audio' | 'video'>): Producer[] {
    const room = this.store.room();
    if (!room) {
      return [];
    }
    return room.producers.filter(
      (producer) =>
        producer.participantId === participantId &&
        producer.status !== 'closed' &&
        (producer.kind === 'audio' || producer.kind === 'video') &&
        (!kind || producer.kind === kind)
    );
  }

  private readSelectedDeviceId(kind: 'audio' | 'video'): string {
    const serviceValue = kind === 'audio' ? this.deviceWebRtc.selectedAudioDeviceId : this.deviceWebRtc.selectedVideoDeviceId;
    const localValue = kind === 'audio' ? this.localSelectedAudioDeviceId() : this.localSelectedVideoDeviceId();
    return this.readDeviceIdState(serviceValue) || localValue;
  }

  private readDeviceIdState(state: DeviceIdState): string {
    if (typeof state === 'function') {
      return state() || '';
    }
    return state || '';
  }

  private setSelectedDeviceId(kind: 'audio' | 'video', deviceId: string): void {
    const serviceValue = kind === 'audio' ? this.deviceWebRtc.selectedAudioDeviceId : this.deviceWebRtc.selectedVideoDeviceId;
    if (this.isWritableDeviceIdSignal(serviceValue)) {
      serviceValue.set(deviceId || null);
    }
    if (kind === 'audio') {
      this.localSelectedAudioDeviceId.set(deviceId);
      return;
    }
    this.localSelectedVideoDeviceId.set(deviceId);
  }

  private isWritableDeviceIdSignal(state: DeviceIdState): state is DeviceIdSignal {
    return typeof state === 'function' && typeof (state as DeviceIdSignal).set === 'function';
  }

  private syncSelectedDevices(stream?: MediaStream): void {
    const audioTrackDeviceId = stream?.getAudioTracks()[0]?.getSettings().deviceId ?? '';
    const videoTrackDeviceId = stream?.getVideoTracks()[0]?.getSettings().deviceId ?? '';
    this.ensureSelectedDevice('audio', this.audioInputDevices(), audioTrackDeviceId);
    this.ensureSelectedDevice('video', this.videoInputDevices(), videoTrackDeviceId);
  }

  private ensureSelectedDevice(kind: 'audio' | 'video', devices: DeviceOption[], preferredDeviceId: string): void {
    const selectedDeviceId = this.readSelectedDeviceId(kind);
    if (selectedDeviceId && (!devices.length || devices.some((device) => device.id === selectedDeviceId))) {
      return;
    }

    const fallbackDeviceId = preferredDeviceId || devices[0]?.id || '';
    if (fallbackDeviceId) {
      this.setSelectedDeviceId(kind, fallbackDeviceId);
    }
  }

  private selectedDeviceLabel(devices: DeviceOption[], selectedDeviceId: string, fallback: string): string {
    if (!selectedDeviceId) {
      return fallback;
    }
    return devices.find((device) => device.id === selectedDeviceId)?.label ?? fallback;
  }

  private applySidebarResize(event: PointerEvent, sidebar: HTMLElement): void {
    const rect = sidebar.getBoundingClientRect();
    const usableHeight = rect.height - this.dividerHeight;
    const minimumTotal = this.minimumParticipantHeight + this.minimumChatHeight;

    if (usableHeight <= minimumTotal) {
      this.sidebarSplitPercent.set(50);
      return;
    }

    const pointerY = event.clientY - rect.top;
    const maximumParticipantHeight = usableHeight - this.minimumChatHeight;
    const clampedParticipantHeight = Math.min(Math.max(pointerY, this.minimumParticipantHeight), maximumParticipantHeight);
    this.sidebarSplitPercent.set(Math.round((clampedParticipantHeight / usableHeight) * 100));
  }

  private clampSplitPercent(value: number): number {
    return Math.min(72, Math.max(28, value));
  }

  protected initials(value: string): string {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : value.slice(0, 2);
    return letters.toUpperCase();
  }
}
