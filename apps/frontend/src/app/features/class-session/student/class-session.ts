import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, ViewChild, computed, inject, signal, type Signal, type WritableSignal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type {
  ClassSessionRecordingEvent,
  Consumer,
  Participant,
  Producer,
  Recording,
  Room,
  RoomOwnerRedirect,
  ServerToClientEvents,
  StudentMediaModerationEvent,
  WhiteboardCommand as WireWhiteboardCommand,
  WhiteboardCommandEvent,
  WhiteboardControlEvent,
  WhiteboardCursorEvent,
  WhiteboardPermissionLevel
} from '@native-sfu/contracts';
import { buildRoomOwnerRedirectUrl } from '../../../core/services/app-environment';
import { AuthService } from '../../../core/services/auth.service';
import { RoomStore } from '../../../core/services/room.store';
import { SocketAckError, SocketService } from '../../../core/services/socket.service';
import { WebRtcService } from '../../../core/services/webrtc.service';
import { MediaStreamDirective } from '../../../shared/media-stream/media-stream.directive';
import { Whiteboard, type WhiteboardCommand, type WhiteboardCursor, type WhiteboardTool } from '../../../shared/whiteboard/whiteboard';
import { ClassSessionService, type ClassroomPayload } from '../class-session.service';
import { SessionChat } from '../session-chat/session-chat';
import { SessionMaterials } from '../session-materials/session-materials';

interface StudentSessionParticipant {
  id: string;
  name: string;
  role: 'Teacher' | 'Student';
  initials: string;
  speaking: boolean;
  handRaised: boolean;
  allowedToSpeak: boolean;
  reconnecting: boolean;
}

interface RemoteStreamEntry {
  id?: string;
  producerId?: string;
  stream?: unknown;
  mediaStream?: unknown;
}

type RemoteStreamRegistry = ReadonlyMap<string, unknown> | Record<string, unknown> | RemoteStreamEntry[] | null | undefined;

interface RemoteWebRtcContract {
  remoteStreams?: () => RemoteStreamRegistry;
  consumeProducer?: (roomId: string, producer: Producer) => Promise<unknown>;
}

type DeviceSelectionValue = string | null | Signal<string | null> | WritableSignal<string | null>;
type ModeratedStudentMediaKind = Extract<Producer['kind'], 'audio' | 'video'>;
type LocalWhiteboardUpsertElement = Extract<WhiteboardCommand, { type: 'upsert' }>['element'];

const DRAW_WHITEBOARD_TOOLS: readonly WhiteboardTool[] = ['pen', 'laser', 'pan'];
const ANNOTATE_WHITEBOARD_TOOLS: readonly WhiteboardTool[] = [
  'pen',
  'line',
  'arrow',
  'rectangle',
  'ellipse',
  'star',
  'text',
  'equation',
  'graph',
  'segment',
  'angle',
  'circle',
  'arc',
  'perpendicular',
  'parallel',
  'midpoint',
  'point',
  'vector',
  'venn',
  'node-edge',
  'tree',
  'flow',
  'probability-tree',
  'laser',
  'pan'
];
const CURRENT_PAGE_EDIT_WHITEBOARD_TOOLS: readonly WhiteboardTool[] = [
  'select',
  'pen',
  'eraser',
  ...ANNOTATE_WHITEBOARD_TOOLS
];

interface DeviceSwitchingWebRtcContract {
  selectedAudioDeviceId?: DeviceSelectionValue;
  selectedVideoDeviceId?: DeviceSelectionValue;
  switchMicrophone?: (deviceId: string | null) => Promise<unknown>;
  switchCamera?: (deviceId: string | null) => Promise<unknown>;
}

interface SessionSnapshotRefreshOptions {
  allowMediaJoin?: boolean;
  forceMediaRejoin?: boolean;
  poll?: boolean;
  preserveLocalTerminal?: boolean;
  silent?: boolean;
}

interface ClassSessionLifecycleEvent {
  sessionId?: string;
  batchId?: string;
  roomId?: string;
  status?: ClassroomPayload['status'];
  payload?: ClassroomPayload;
}

interface TeacherMediaDisableCommand {
  kind: ModeratedStudentMediaKind;
  roomId?: string;
  participantId?: string;
  userId?: string;
  message?: string;
}

type TerminalClassSessionStatus = Extract<ClassroomPayload['status'], 'completed' | 'cancelled'>;
const TEACHER_MEDIA_STREAM_TIMEOUT_MS = 7_000;
const TEACHER_MEDIA_STREAM_MAX_RETRIES = 2;

@Component({
  selector: 'sfu-student-class-session',
  standalone: true,
  imports: [RouterLink, SessionChat, SessionMaterials, MediaStreamDirective, Whiteboard],
  templateUrl: './class-session.html',
  styleUrl: './class-session.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class StudentClassSession implements OnInit, OnDestroy {
  private readonly lifecycleEventNames = ['session:started', 'session:ended'];
  private readonly moderationCommandEventNames = [
    'moderation:command',
    'moderation:applied',
    'participant:moderation-command',
    'participant:media-command',
    'participant:media-disabled',
    'participant:force-muted',
    'participant:muted',
    'participant:camera-disabled',
    'participant:camera-stopped'
  ];
  private readonly lifecyclePollIntervalMs = 10_000;
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly classSessions = inject(ClassSessionService);
  private readonly socket = inject(SocketService);
  private readonly store = inject(RoomStore);
  private readonly webrtc = inject(WebRtcService);
  private readonly remoteWebRtc = this.webrtc as WebRtcService & RemoteWebRtcContract;
  private readonly deviceWebRtc = this.webrtc as WebRtcService & DeviceSwitchingWebRtcContract;
  private readonly socketDisposers: Array<() => void> = [];
  private readonly consumedProducerIds = new Set<string>();
  private readonly pendingProducerIds = new Set<string>();
  private readonly teacherMediaWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly teacherMediaRetryCounts = new Map<string, number>();
  private readonly consumerProducerIds = new Map<string, string>();
  private joinedRoomId = '';
  private watchedSessionId = '';
  private destroyed = false;
  private lifecyclePollTimer: ReturnType<typeof setInterval> | undefined;
  private lifecyclePollInFlight = false;
  private lifecycleSocketEventReceived = false;
  private lifecycleWatchPending = false;
  private lifecycleWatchSupported = false;
  private socketConnectedOnce = false;
  private mediaDevicesPrepared = false;
  private browserRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private activityHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private lastUserActivityAt = Date.now();
  private lastActivitySentAt = 0;
  private readonly whiteboardCursorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingWhiteboardCommands: WhiteboardCommand[] = [];

  @ViewChild(Whiteboard) private readonly interactiveWhiteboard?: Whiteboard;

  protected readonly session = signal<ClassroomPayload | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly mediaError = signal('');
  protected readonly localMediaError = signal('');
  protected readonly deviceError = signal('');
  protected readonly teacherAudioPlaybackBlocked = signal(false);
  protected readonly downloadingRecording = signal(false);
  protected readonly joiningMedia = signal(false);
  protected readonly publishingStudentMedia = signal(false);
  protected readonly refreshingDevices = signal(false);
  protected readonly switchingAudioDevice = signal(false);
  protected readonly switchingVideoDevice = signal(false);
  protected readonly updatingHandRaise = signal(false);
  protected readonly localAudioEnabled = signal(false);
  protected readonly localVideoEnabled = signal(false);
  protected readonly chatDisplayName = computed(() => this.auth.user()?.name ?? 'Student');
  protected readonly teacherDisabledAudio = signal(false);
  protected readonly teacherDisabledVideo = signal(false);
  private readonly teacherModerationNotice = signal('');
  private readonly selectedAudioDeviceFallback = signal('');
  private readonly selectedVideoDeviceFallback = signal('');
  protected readonly localProducerIds = signal<readonly string[]>([]);
  protected readonly participantsOpen = signal(false);
  protected readonly materialsOpen = signal(false);
  protected readonly whiteboardControlGranted = signal(false);
  protected readonly whiteboardPermissionLevel = signal<WhiteboardPermissionLevel>('view_only');
  protected readonly whiteboardPermittedPageId = signal('');
  protected readonly whiteboardDrawerOpen = signal(false);
  protected readonly whiteboardControlNotice = signal('');
  protected readonly whiteboardCursors = signal<WhiteboardCursor[]>([]);
  protected readonly returnedRemoteStreams = signal<Record<string, MediaStream>>({});
  protected readonly mediaRecoveryError = this.webrtc.lastMediaError;
  protected readonly localStream = this.webrtc.localStream;
  protected readonly localVideoPreviewStream = computed(() => {
    const stream = this.localStream();
    return stream && this.localVideoEnabled() && stream.getVideoTracks().some((track) => track.readyState === 'live') ? stream : null;
  });
  protected readonly sessionLive = computed(() => this.session()?.status === 'live');
  protected readonly liveSettings = computed(() => this.session()?.resolvedLiveSettings ?? null);
  protected readonly studentWhiteboardReadOnly = computed(
    () => !this.whiteboardControlGranted() || !this.sessionLive() || this.whiteboardPermissionLevel() === 'view_only'
  );
  protected readonly studentWhiteboardPermissionLabel = computed(() => this.whiteboardPermissionLabel(this.whiteboardPermissionLevel()));
  protected readonly studentWhiteboardTools = computed<readonly WhiteboardTool[]>(() => {
    switch (this.whiteboardPermissionLevel()) {
      case 'draw':
        return DRAW_WHITEBOARD_TOOLS;
      case 'current_page_edit':
        return CURRENT_PAGE_EDIT_WHITEBOARD_TOOLS;
      case 'annotate':
        return ANNOTATE_WHITEBOARD_TOOLS;
      default:
        return ['pan'];
    }
  });
  protected readonly studentCanSelfUnmute = computed(() => this.liveSettings()?.media.allowStudentsToUnmuteSelf !== false);
  protected readonly studentCanSelfStartCamera = computed(() => this.liveSettings()?.media.allowStudentsToStartCameraSelf !== false);
  protected readonly prejoinDeviceCheckRequired = computed(() => this.liveSettings()?.media.requirePrejoinDeviceCheck !== false);
  protected readonly handRaiseAvailable = computed(() => this.liveSettings()?.speaking.handRaiseEnabled !== false);
  protected readonly activeRecording = computed(() => this.session()?.activeRecording ?? null);
  protected readonly latestRecording = computed(() => this.session()?.latestRecording ?? null);
  protected readonly recordingActive = computed(() => this.isActiveRecording(this.activeRecording()));
  protected readonly recordingStatusLabel = computed(() => {
    const active = this.activeRecording();
    if (active?.status === 'starting') return 'Recording starting';
    if (active?.status === 'recording') return 'Recording';
    if (active?.status === 'stopping') return 'Recording stopping';
    const latest = this.latestRecording();
    if (latest?.status === 'stopped') return 'Recording ready';
    if (latest?.status === 'failed') return 'Recording failed';
    return '';
  });
  protected readonly audioInputs = computed(() => this.deviceWebRtc.devices().audioInputs);
  protected readonly videoInputs = computed(() => this.deviceWebRtc.devices().videoInputs);
  protected readonly selectedAudioDeviceId = computed(
    () => this.readDeviceSelection(this.deviceWebRtc.selectedAudioDeviceId) || this.selectedAudioDeviceFallback() || this.audioInputs()[0]?.id || ''
  );
  protected readonly selectedVideoDeviceId = computed(
    () => this.readDeviceSelection(this.deviceWebRtc.selectedVideoDeviceId) || this.selectedVideoDeviceFallback() || this.videoInputs()[0]?.id || ''
  );
  protected readonly hasLocalMedia = computed(() => Boolean(this.localStream()));
  protected readonly studentInitials = computed(() => this.initials(this.chatDisplayName()));
  protected readonly teacherModerationMessage = computed(() => {
    if (this.teacherDisabledAudio() && this.teacherDisabledVideo()) return 'Teacher disabled your microphone and camera.';
    if (this.teacherDisabledAudio()) return this.teacherModerationNotice() || 'Teacher muted your microphone.';
    if (this.teacherDisabledVideo()) return this.teacherModerationNotice() || 'Teacher stopped your camera.';
    return '';
  });
  protected readonly mediaDeviceProblem = computed(
    () =>
      this.teacherModerationMessage() ||
      this.deviceError() ||
      this.localMediaError() ||
      (this.teacherAudioPlaybackBlocked() ? 'Browser blocked teacher audio.' : this.mediaRecoveryError()?.message ?? '')
  );
  protected readonly networkWarning = computed(() => {
    const policy = this.liveSettings()?.bandwidthPolicy;
    if (policy?.showNetworkWarnings === false || this.webrtc.networkScore() > 2) {
      return '';
    }
    return policy?.preferAudioOnPoorNetwork
      ? 'Network is weak. Audio will be more reliable than video.'
      : 'Network is weak. Media may take longer to recover.';
  });
  protected readonly canSwitchAudioDevice = computed(
    () =>
      !this.teacherDisabledAudio() &&
      this.studentCanSelfUnmute() &&
      !this.publishingStudentMedia() &&
      !this.switchingAudioDevice() &&
      !this.refreshingDevices() &&
      this.audioInputs().length > 0
  );
  protected readonly canSwitchVideoDevice = computed(
    () =>
      !this.teacherDisabledVideo() &&
      this.studentCanSelfStartCamera() &&
      !this.publishingStudentMedia() &&
      !this.switchingVideoDevice() &&
      !this.refreshingDevices() &&
      this.videoInputs().length > 0
  );
  protected readonly localMediaPublished = computed(() => this.localProducerIds().length > 0);
  protected readonly localMediaStatus = computed(() => {
    if (this.refreshingDevices()) return 'Refreshing devices';
    if (this.switchingAudioDevice()) return 'Switching microphone';
    if (this.switchingVideoDevice()) return 'Switching camera';
    if (this.publishingStudentMedia()) return 'Starting media';
    if (this.teacherDisabledAudio() && this.teacherDisabledVideo()) return 'Mic and camera disabled by teacher';
    if (this.teacherDisabledAudio()) return 'Mic disabled by teacher';
    if (this.teacherDisabledVideo()) return 'Camera disabled by teacher';
    if (!this.studentCanSelfUnmute() && !this.studentCanSelfStartCamera()) return 'Mic and camera locked by class settings';
    if (!this.studentCanSelfUnmute()) return 'Mic locked by class settings';
    if (!this.studentCanSelfStartCamera()) return 'Camera locked by class settings';
    if (this.localMediaError()) return this.localMediaError();
    if (this.deviceError()) return 'Device needs attention';
    if (!this.roomJoined()) {
      if (!this.localAudioEnabled() && !this.localVideoEnabled()) return 'Mic off / Camera off';
      if (this.localAudioEnabled() && this.localVideoEnabled()) return 'Mic and camera preview on';
      if (this.localAudioEnabled()) return 'Mic preview on';
      return 'Camera preview on';
    }
    if (!this.localMediaPublished()) return 'Media off';
    if (!this.localAudioEnabled() && !this.localVideoEnabled()) return 'Mic and camera off';
    if (!this.localAudioEnabled()) return 'Mic off';
    if (!this.localVideoEnabled()) return 'Camera off';
    return 'You are live';
  });
  protected readonly prejoinJoinDisabled = computed(() => this.joiningMedia() || (this.prejoinDeviceCheckRequired() && this.refreshingDevices()));
  protected readonly prejoinPolicyHint = computed(() => {
    if (!this.prejoinDeviceCheckRequired()) return 'Device check is optional for this class.';
    if (this.refreshingDevices()) return 'Checking available camera and microphone devices.';
    if (this.deviceError()) return this.deviceError();
    return 'Device check complete.';
  });
  protected readonly localParticipantState = computed(() => {
    const participantId = this.store.localParticipantId();
    return participantId ? this.store.room()?.participants.find((participant) => participant.id === participantId) ?? null : null;
  });
  protected readonly handRaised = computed(() => Boolean(this.localParticipantState()?.handRaised));
  protected readonly allowedToSpeak = computed(() => Boolean(this.localParticipantState()?.allowedToSpeak));
  protected readonly handRaiseLabel = computed(() => {
    if (this.updatingHandRaise()) return 'Updating';
    if (this.allowedToSpeak()) return 'Allowed to speak';
    return this.handRaised() ? 'Lower hand' : 'Raise hand';
  });
  protected readonly speakingPermissionLabel = computed(() => {
    if (this.allowedToSpeak()) return 'Teacher allowed you to speak.';
    if (!this.handRaiseAvailable()) return 'Hand raise is disabled for this class.';
    if (this.teacherDisabledAudio()) return 'Teacher muted your microphone.';
    if (this.handRaised()) return 'Waiting for teacher.';
    return 'Raise your hand to request the mic.';
  });
  protected readonly participants = computed<StudentSessionParticipant[]>(() => {
    const room = this.store.room();
    if (room && this.isCurrentRoom(room.id) && room.participants.length) {
      return room.participants.map((participant) => this.roomParticipant(participant));
    }
    return (
      this.session()?.participants.map((participant) => ({
        id: participant.id,
        name: participant.displayName,
        role: participant.role === 'teacher' ? 'Teacher' : 'Student',
        initials: this.initials(participant.displayName),
        speaking: participant.role === 'teacher',
        handRaised: false,
        allowedToSpeak: false,
        reconnecting: false
      })) ?? []
    );
  });
  protected readonly teacherParticipant = computed(() => this.findTeacherParticipant());
  protected readonly teacherReconnecting = computed(() => this.sessionLive() && this.teacherParticipant()?.connected === false);
  protected readonly teacherCameraProducer = computed(() => this.findTeacherProducer('video'));
  protected readonly teacherScreenProducer = computed(() => this.findTeacherProducer('screen'));
  protected readonly teacherAudioProducer = computed(() => this.findTeacherProducer('audio'));
  protected readonly hasScreenShare = computed(() => Boolean(this.teacherScreenProducer()));
  protected readonly stageProducer = computed(() => this.teacherScreenProducer() ?? this.teacherCameraProducer());
  protected readonly pipProducer = computed(() => (this.teacherScreenProducer() ? this.teacherCameraProducer() : null));
  protected readonly stageStream = computed(() => this.streamForProducer(this.stageProducer()?.id));
  protected readonly pipStream = computed(() => this.streamForProducer(this.pipProducer()?.id));
  protected readonly teacherAudioStream = computed(() => this.streamForProducer(this.teacherAudioProducer()?.id));
  protected readonly teacherName = computed(() => this.teacherParticipant()?.displayName ?? 'Teacher');
  protected readonly stageTitle = computed(() => {
    const screenProducer = this.teacherScreenProducer();
    return screenProducer ? this.sharedContentTitle(screenProducer) : `${this.teacherName()} camera`;
  });
  protected readonly stageInitials = computed(() => this.initials(this.teacherName()));
  protected readonly stageStatusText = computed(() => {
    if (this.mediaError()) return this.mediaError();
    if (!this.roomJoined()) return 'Join to watch teacher media.';
    if (this.teacherReconnecting()) return 'Teacher reconnecting. The class is still live.';
    if (this.joiningMedia()) return 'Joining classroom media.';
    const producer = this.stageProducer();
    if (!producer) return 'Waiting for the teacher camera.';
    if (!this.remoteWebRtc.remoteStreams) return 'Remote media receive support is not available yet.';
    if (!this.streamForProducer(producer.id)) {
      return producer.kind === 'screen' ? this.sharedContentStatusText(producer, 'connecting') : 'Connecting to the teacher camera.';
    }
    return producer.kind === 'screen' ? this.sharedContentStatusText(producer, 'live') : 'Camera live';
  });
  protected readonly blockedMessage = computed(() => {
    const status = this.session()?.status;
    if (status === 'completed') return 'This class session has ended.';
    if (status === 'cancelled') return 'This class session was cancelled.';
    return 'Waiting for the teacher to start this class.';
  });

  ngOnInit(): void {
    this.bindSocketEvents();
    this.bindBrowserRecoveryEvents();
    this.loadSession();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopLifecyclePolling();
    this.clearBrowserRecoveryTimer();
    this.stopActivityHeartbeat();
    this.clearTeacherMediaWatchdogs();
    for (const dispose of this.socketDisposers.splice(0)) {
      dispose();
    }
    this.unwatchCurrentSession();
    void this.leaveCurrentRoom();
  }

  protected toggleParticipants(): void {
    this.participantsOpen.update((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        this.materialsOpen.set(false);
        this.whiteboardDrawerOpen.set(false);
      }
      return nextOpen;
    });
  }

  protected closeParticipants(): void {
    this.participantsOpen.set(false);
  }

  protected toggleMaterials(): void {
    this.materialsOpen.update((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        this.participantsOpen.set(false);
        this.whiteboardDrawerOpen.set(false);
      }
      return nextOpen;
    });
  }

  protected closeMaterials(): void {
    this.materialsOpen.set(false);
  }

  protected toggleWhiteboardDrawer(): void {
    if (!this.whiteboardControlGranted()) {
      return;
    }
    this.whiteboardDrawerOpen.update((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        this.participantsOpen.set(false);
        this.materialsOpen.set(false);
      }
      return nextOpen;
    });
    window.setTimeout(() => this.flushPendingWhiteboardCommands(), 0);
  }

  protected closeWhiteboardDrawer(): void {
    this.whiteboardDrawerOpen.set(false);
  }

  protected roomJoined(): boolean {
    return Boolean(this.joinedRoomId);
  }

  protected joinClass(): void {
    const payload = this.session();
    if (!payload || payload.status !== 'live' || !payload.canJoin) {
      this.mediaError.set('This class is not open for joining yet.');
      return;
    }
    if (this.joiningMedia()) {
      return;
    }
    if (this.prejoinDeviceCheckRequired() && this.refreshingDevices()) {
      this.mediaError.set('Device check is still running. Please wait a moment.');
      return;
    }
    this.joiningMedia.set(true);
    this.mediaError.set('');
    this.classSessions.joinSession(payload.sessionId, payload.batchId).subscribe({
      next: (joinedPayload) => {
        this.applyPayload(joinedPayload, false);
        void this.joinClassroomRoom(joinedPayload, true);
      },
      error: (error) => {
        this.mediaError.set(this.classSessions.errorMessage(error));
        this.joiningMedia.set(false);
      }
    });
  }

  protected async toggleMicrophone(): Promise<void> {
    if (!this.localAudioEnabled() && !this.studentCanSelfUnmute()) {
      this.localMediaError.set('Microphone self-unmute is disabled for this class.');
      return;
    }
    await this.setStudentMediaKindEnabled('audio', !this.localAudioEnabled());
  }

  protected async toggleCamera(): Promise<void> {
    if (!this.localVideoEnabled() && !this.studentCanSelfStartCamera()) {
      this.localMediaError.set('Camera self-start is disabled for this class.');
      return;
    }
    await this.setStudentMediaKindEnabled('video', !this.localVideoEnabled());
  }

  protected async toggleHandRaise(): Promise<void> {
    if (!this.handRaiseAvailable()) {
      this.mediaError.set('Hand raise is disabled for this class.');
      return;
    }
    const roomId = this.joinedRoomId;
    const participantId = this.store.localParticipantId();
    if (!roomId || !participantId || !this.sessionLive() || this.updatingHandRaise()) {
      return;
    }
    this.updatingHandRaise.set(true);
    this.mediaError.set('');
    try {
      const patch = await this.socket.emitAck('hand:raise', { roomId, raised: !this.handRaised() });
      this.store.patchParticipant(participantId, patch as Partial<Participant>);
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to update hand raise.');
    } finally {
      this.updatingHandRaise.set(false);
    }
  }

  protected handleStudentWhiteboardCommand(command: WhiteboardCommand): void {
    const roomId = this.joinedRoomId;
    if (!roomId || !this.whiteboardControlGranted() || !this.sessionLive()) {
      return;
    }
    const normalizedCommand = this.normalizeWhiteboardCommand(command);
    if (!this.isStudentWhiteboardCommandAllowed(normalizedCommand)) {
      this.whiteboardControlNotice.set('That whiteboard action is not allowed for your current permission.');
      return;
    }
    void this.socket
      .emitAck('whiteboard:command', { roomId, command: this.toWireWhiteboardCommand(normalizedCommand) })
      .catch((error) => {
        this.whiteboardControlNotice.set(error instanceof Error ? error.message : 'Unable to sync whiteboard change.');
      });
  }

  protected handleStudentWhiteboardCursor(cursor: WhiteboardCursor): void {
    const roomId = this.joinedRoomId;
    if (!roomId || !this.whiteboardControlGranted() || !this.sessionLive()) {
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

  protected async refreshMediaDevices(): Promise<void> {
    if (this.refreshingDevices()) {
      return;
    }
    this.refreshingDevices.set(true);
    this.deviceError.set('');
    try {
      await this.deviceWebRtc.refreshDevices();
      this.syncSelectedDevicesFromLocalStream();
    } catch (error) {
      this.deviceError.set(this.mediaRecoveryError()?.message ?? this.deviceErrorMessage(error, 'Unable to refresh camera and microphone devices.'));
    } finally {
      this.refreshingDevices.set(false);
    }
  }

  protected handleTeacherAudioPlaybackBlocked(error: unknown): void {
    this.teacherAudioPlaybackBlocked.set(true);
    const mediaError = this.webrtc.recordAutoplayBlocked(error);
    this.mediaError.set(mediaError.message);
  }

  protected handleTeacherVideoPlaybackBlocked(_error: unknown): void {
    this.mediaError.set('Teacher video could not start automatically. Tap retry media if the stage stays blank.');
  }

  protected async runStudentMediaRecovery(): Promise<void> {
    const recoveryError = this.mediaRecoveryError();
    if (this.teacherAudioPlaybackBlocked() || recoveryError?.code === 'autoplay_blocked') {
      await this.enableTeacherAudio();
      return;
    }
    if (this.joiningMedia() || this.publishingStudentMedia() || this.refreshingDevices()) {
      return;
    }
    if (recoveryError?.kind === 'consumer') {
      this.mediaError.set('');
      await this.consumeAvailableTeacherProducers();
      return;
    }
    if (recoveryError?.operation === 'refresh' || recoveryError?.code === 'device_unavailable') {
      await this.refreshMediaDevices();
      return;
    }
    const payload = this.session();
    if (payload && this.roomJoined()) {
      await this.publishEnabledStudentMedia(payload);
      return;
    }
    await this.refreshMediaDevices();
  }

  protected async enableTeacherAudio(): Promise<void> {
    const audio = document.querySelector<HTMLAudioElement>('.teacher-audio');
    if (!audio) {
      this.teacherAudioPlaybackBlocked.set(false);
      this.webrtc.clearMediaIssue('audio');
      return;
    }
    try {
      await audio.play();
      this.teacherAudioPlaybackBlocked.set(false);
      this.webrtc.clearMediaIssue('audio');
      if (this.mediaRecoveryError()?.code === 'autoplay_blocked') {
        this.mediaError.set('');
      }
    } catch (error) {
      const mediaError = this.webrtc.recordAutoplayBlocked(error);
      this.mediaError.set(mediaError.message);
    }
  }

  protected async switchMicrophone(deviceId: string): Promise<void> {
    const nextDeviceId = deviceId.trim();
    if (this.switchingAudioDevice()) {
      return;
    }
    if (this.teacherDisabledAudio()) {
      this.showTeacherDisabledMessage('audio');
      return;
    }
    this.writeDeviceSelection('selectedAudioDeviceId', this.selectedAudioDeviceFallback, nextDeviceId);
    if (!this.localAudioEnabled()) {
      return;
    }
    try {
      await this.startOrSwitchLocalTrack('audio', nextDeviceId);
      await this.publishOrResumeStudentMediaKind('audio');
    } catch (error) {
      this.deviceError.set(this.mediaRecoveryError()?.message ?? this.deviceErrorMessage(error, 'Unable to switch microphones.'));
    }
  }

  protected async switchCamera(deviceId: string): Promise<void> {
    const nextDeviceId = deviceId.trim();
    if (this.switchingVideoDevice()) {
      return;
    }
    if (this.teacherDisabledVideo()) {
      this.showTeacherDisabledMessage('video');
      return;
    }
    this.writeDeviceSelection('selectedVideoDeviceId', this.selectedVideoDeviceFallback, nextDeviceId);
    if (!this.localVideoEnabled()) {
      return;
    }
    try {
      await this.startOrSwitchLocalTrack('video', nextDeviceId);
      await this.publishOrResumeStudentMediaKind('video');
    } catch (error) {
      this.deviceError.set(this.mediaRecoveryError()?.message ?? this.deviceErrorMessage(error, 'Unable to switch cameras.'));
    }
  }

  private loadSession(): void {
    const sessionId = this.route.snapshot.queryParamMap.get('sessionId') ?? '';
    const batchId = this.route.snapshot.queryParamMap.get('batchId') ?? '';
    if (sessionId && batchId) {
      this.classSessions.getSession(sessionId, batchId).subscribe({
        next: (payload) => {
          this.applyPayload(payload, false);
          this.loading.set(false);
        },
        error: (error) => this.applyError(error)
      });
      return;
    }
    if (batchId) {
      this.classSessions.getCurrentForBatch(batchId).subscribe({
        next: (payload) => {
          this.applyPayload(payload, false);
          this.loading.set(false);
        },
        error: (error) => this.applyError(error)
      });
      return;
    }
    this.loading.set(false);
    this.error.set('Open this class from your student dashboard.');
  }

  private joinSession(sessionId: string, batchId: string, showLoading = true, forceMediaRejoin = false): void {
    if (showLoading) {
      this.loading.set(true);
    }
    this.error.set('');
    this.classSessions.joinSession(sessionId, batchId).subscribe({
      next: (payload) => {
        this.applyPayload(payload, true, forceMediaRejoin);
        if (showLoading) {
          this.loading.set(false);
        }
      },
      error: () => {
        this.classSessions.getSession(sessionId, batchId).subscribe({
          next: (payload) => {
            this.applyPayload(payload, false);
            if (showLoading) {
              this.loading.set(false);
            }
          },
          error: (error) => {
            if (showLoading) {
              this.applyError(error);
            }
          }
        });
      }
    });
  }

  private applyPayload(payload: ClassroomPayload, allowMediaJoin: boolean, forceMediaRejoin = false): void {
    const previousSessionId = this.session()?.sessionId;
    if (previousSessionId && previousSessionId !== payload.sessionId) {
      this.resetTeacherModerationState();
    }
    this.session.set(payload);
    this.watchSession(payload.sessionId, payload.batchId);
    if (payload.status !== 'live') {
      if (payload.status === 'scheduled') {
        this.startLifecyclePolling();
      } else {
        this.stopLifecyclePolling();
      }
      if (this.joinedRoomId || this.localMediaPublished()) {
        void this.leaveCurrentRoom();
      }
      return;
    }

    this.stopLifecyclePolling();
    this.preparePrejoinDevices();
    if (allowMediaJoin && payload.status === 'live' && payload.canJoin && this.joinedRoomId) {
      void this.joinClassroomRoom(payload, forceMediaRejoin);
    }
  }

  protected downloadLatestRecording(): void {
    const session = this.session();
    const recording = this.latestRecording();
    const recordingId = recording?.recordingId ?? recording?.id;
    if (!session || !recordingId || this.downloadingRecording()) {
      return;
    }
    this.downloadingRecording.set(true);
    this.classSessions.downloadRecording(session.sessionId, recordingId, session.batchId).subscribe({
      next: (blob) => {
        this.saveBlob(blob, `class-session-${session.sessionNumber}-recording.json`);
        this.downloadingRecording.set(false);
      },
      error: (error) => {
        this.deviceError.set(this.classSessions.errorMessage(error));
        this.downloadingRecording.set(false);
      }
    });
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
    if (event.status === 'failed') {
      this.deviceError.set(event.reason || event.recording.failureReason || 'Recording failed.');
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

  private preparePrejoinDevices(): void {
    if (this.mediaDevicesPrepared) {
      return;
    }
    this.mediaDevicesPrepared = true;
    const settings = this.liveSettings();
    if (settings) {
      this.localAudioEnabled.set(!settings.media.studentsJoinMuted && settings.media.allowStudentsToUnmuteSelf);
      this.localVideoEnabled.set(!settings.media.studentsJoinCameraOff && settings.media.allowStudentsToStartCameraSelf);
    }
    void this.refreshMediaDevices();
  }

  private applyError(error: unknown): void {
    this.error.set(this.classSessions.errorMessage(error));
    this.loading.set(false);
  }

  private async joinClassroomRoom(payload: ClassroomPayload, forceRejoin = false): Promise<void> {
    if (this.isTerminalStatus(payload.status) || this.isTerminalStatus(this.session()?.status)) {
      this.joiningMedia.set(false);
      return;
    }
    if (!payload.roomId) {
      this.mediaError.set('Classroom media room is not available yet.');
      this.joiningMedia.set(false);
      return;
    }
    if (this.joinedRoomId === payload.roomId && !forceRejoin) {
      this.joiningMedia.set(false);
      return;
    }
    if (this.joinedRoomId) {
      await this.leaveCurrentRoom({ preserveMediaIntent: forceRejoin });
    }
    const displayName = this.studentDisplayName(payload);
    this.joiningMedia.set(true);
    this.mediaError.set('');
    try {
      const response = await this.socket.emitAck('room:join', { roomId: payload.roomId, displayName, asViewer: false });
      if (this.destroyed || this.isTerminalStatus(this.session()?.status)) {
        await this.socket.emitAck('room:leave', { roomId: payload.roomId }).catch(() => undefined);
        return;
      }
      this.joinedRoomId = payload.roomId;
      this.store.setRoom(response.room);
      this.store.setLocalParticipant(response.participantId);
      this.syncTeacherModerationFromLocalParticipant();
      this.syncLocalParticipantMediaState();
      this.startActivityHeartbeat();
      await this.consumeAvailableTeacherProducers();
      await this.publishEnabledStudentMedia(payload);
    } catch (error) {
      if (this.followRoomOwnerRedirect(error, payload.roomId, displayName)) {
        this.joinedRoomId = '';
        return;
      }
      this.joinedRoomId = '';
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to join classroom media.');
    } finally {
      this.joiningMedia.set(false);
    }
  }

  private bindSocketEvents(): void {
    this.bindSocketConnectionEvents();
    this.bindLifecycleSocketEvents();
    this.bindModerationSocketEvents();
    this.registerSocketHandler('student:media-moderated', (event) => this.handleStudentMediaModerated(event));
    this.registerSocketHandler('whiteboard:control-granted', (event) => this.applyWhiteboardControlEvent(event));
    this.registerSocketHandler('whiteboard:control-revoked', (event) => this.applyWhiteboardControlEvent(event));
    this.registerSocketHandler('whiteboard:command', (event) => this.applyRemoteWhiteboardCommand(event));
    this.registerSocketHandler('whiteboard:cursor', (event) => this.applyRemoteWhiteboardCursor(event));
    this.registerSocketHandler('recording:started', (event) => this.applyRecordingEvent(event));
    this.registerSocketHandler('recording:updated', (event) => this.applyRecordingEvent(event));
    this.registerSocketHandler('recording:stopped', (event) => this.applyRecordingEvent(event));
    this.registerSocketHandler('recording:failed', (event) => this.applyRecordingEvent(event));
    this.registerSocketHandler('room:updated', (room) => {
      if (this.isCurrentRoom(room.id)) {
        this.cleanupRemovedRoomProducers(room);
        this.store.setRoom(room);
        this.syncTeacherModerationFromLocalParticipant();
        void this.consumeAvailableTeacherProducers();
      }
    });
    this.registerSocketHandler('participant:joined', (participant) => {
      if (this.isCurrentRoom(this.store.room()?.id)) {
        this.store.upsertParticipant(participant);
      }
    });
    this.registerSocketHandler('participant:left', (participantId) => {
      if (this.isCurrentRoom(this.store.room()?.id)) {
        this.store.removeParticipant(participantId);
      }
    });
    this.registerSocketHandler('participant:updated', (participantId, patch) => {
      if (this.isCurrentRoom(this.store.room()?.id)) {
        this.store.patchParticipant(participantId, patch as Participant);
        this.applyLocalParticipantMediaPatch(participantId, patch);
      }
    });
    this.registerSocketHandler('permissions:updated', (participantId, permissions) => {
      if (this.isCurrentRoom(this.store.room()?.id)) {
        this.store.patchParticipant(participantId, { permissions } as Participant);
        this.applyLocalParticipantPermissionsPatch(participantId, permissions);
      }
    });
    this.registerSocketHandler('producer:created', (producer) => this.applyProducerEvent(producer));
    this.registerSocketHandler('producer:updated', (producer) => this.applyProducerEvent(producer));
    this.registerSocketHandler('producer:closed', (producerId) => {
      this.store.removeProducer(producerId);
      this.forgetLocalProducer(producerId);
      this.cleanupRemoteProducer(producerId);
    });
    this.registerSocketHandler('producer:score-updated', (state) => {
      if (this.isCurrentRoom(state.roomId)) {
        this.store.applyProducerQuality(state);
      }
    });
    this.registerSocketHandler('producer:dynacast-updated', (event) => {
      if (this.isCurrentRoom(event.roomId)) {
        this.store.applyProducerDynacast(event);
      }
    });
    this.registerSocketHandler('consumer:created', (consumer) => {
      this.applyConsumerEvent(consumer);
    });
    this.registerSocketHandler('consumer:updated', (consumer) => {
      this.applyConsumerEvent(consumer);
    });
    this.registerSocketHandler('consumer:closed', (consumerId) => {
      const room = this.store.room();
      const producerId = this.consumerProducerIds.get(consumerId) ?? room?.consumers.find((consumer) => consumer.id === consumerId)?.producerId;
      this.consumerProducerIds.delete(consumerId);
      if (this.isCurrentRoom(room?.id) && room?.consumers.some((consumer) => consumer.id === consumerId)) {
        this.store.room.set({
          ...room,
          consumers: room.consumers.filter((consumer) => consumer.id !== consumerId)
        });
      }
      if (producerId) {
        this.cleanupRemoteProducer(producerId);
      }
    });
    this.registerSocketHandler('consumer:score-updated', (state) => {
      if (this.isCurrentRoom(state.roomId)) {
        this.store.applyConsumerQuality(state);
      }
    });
    this.registerSocketHandler('network:quality', (quality) => {
      if (quality.participantId === this.store.localParticipantId()) {
        this.webrtc.networkScore.set(quality.score);
      }
    });
    this.registerSocketHandler('consumer:layers-changed', (event) => this.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:layers-switching', (event) => this.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:layers-unavailable', (event) => this.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:layers-switch-failed', (event) => this.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:svc-layers-changed', (event) => this.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:svc-layers-switching', (event) => this.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:svc-layers-unavailable', (event) => this.applyConsumerLayerEvent(event));
    this.registerSocketHandler('consumer:svc-layers-switch-failed', (event) => this.applyConsumerLayerEvent(event));
    this.registerSocketHandler('room:failed', (event) => {
      if (this.isCurrentRoom(event.roomId)) {
        this.mediaError.set(event.message);
      }
    });
    this.registerSocketHandler('room:closed', (roomId) => {
      if (this.isCurrentRoom(roomId)) {
        this.handleClassroomRoomClosed(roomId);
      }
    });
  }

  private bindSocketConnectionEvents(): void {
    const socket = this.socket.connect();
    this.socketConnectedOnce = socket.connected;
    this.registerRawSocketHandler('connect', () => {
      const session = this.session();
      if (session) {
        this.watchSession(session.sessionId, session.batchId, true);
      }
      if (!this.socketConnectedOnce) {
        this.socketConnectedOnce = true;
        return;
      }
      this.refreshSessionSnapshot({ allowMediaJoin: true, forceMediaRejoin: Boolean(this.joinedRoomId), silent: true });
    });
    this.registerRawSocketHandler('disconnect', () => {
      if (this.sessionLive()) {
        this.mediaError.set('Connection lost. Reconnecting when the network returns...');
      }
    });
  }

  private bindBrowserRecoveryEvents(): void {
    const handleOnline = () => this.requestBrowserRecovery('online');
    const handleOffline = () => {
      if (this.sessionLive()) {
        this.mediaError.set('You are offline. The class will try to recover when the network returns.');
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
      if (this.sessionLive()) {
        this.mediaError.set(reason === 'online' ? 'Network restored. Recovering classroom media...' : '');
      }
      this.refreshSessionSnapshot({ allowMediaJoin: true, forceMediaRejoin: Boolean(this.joinedRoomId), silent: true });
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

  private bindLifecycleSocketEvents(): void {
    for (const eventName of this.lifecycleEventNames) {
      this.registerRawSocketHandler(eventName, (payload) => this.handleClassSessionLifecycleEvent(eventName, payload));
    }
  }

  private bindModerationSocketEvents(): void {
    for (const eventName of this.moderationCommandEventNames) {
      this.registerRawSocketHandler(eventName, (...args) => this.handleModerationSocketEvent(eventName, args));
    }
  }

  private registerSocketHandler<K extends keyof ServerToClientEvents>(
    event: K,
    handler: (...args: Parameters<ServerToClientEvents[K]>) => void
  ): void {
    this.socket.on(event, handler);
    this.socketDisposers.push(() => this.socket.off(event, handler));
  }

  private registerRawSocketHandler(event: string, handler: (...args: unknown[]) => void): void {
    const socket = this.socket.connect() as unknown as {
      on: (name: string, listener: (...args: unknown[]) => void) => void;
      off: (name: string, listener: (...args: unknown[]) => void) => void;
    };
    socket.on(event, handler);
    this.socketDisposers.push(() => socket.off(event, handler));
  }

  private watchSession(sessionId: string, batchId?: string, force = false): void {
    if (!sessionId || (!force && this.watchedSessionId === sessionId)) {
      return;
    }
    if (this.watchedSessionId && this.watchedSessionId !== sessionId) {
      this.unwatchCurrentSession();
    }
    this.watchedSessionId = sessionId;
    this.lifecycleWatchPending = true;
    this.lifecycleWatchSupported = false;
    void this.socket
      .emitAck('session:watch', { sessionId, ...(batchId ? { batchId } : {}) })
      .then(() => {
        if (this.destroyed || this.watchedSessionId !== sessionId) {
          return;
        }
        this.lifecycleWatchPending = false;
        this.lifecycleWatchSupported = true;
        this.stopLifecyclePolling();
      })
      .catch((error) => {
        if (this.destroyed || this.watchedSessionId !== sessionId) {
          return;
        }
        this.lifecycleWatchPending = false;
        this.lifecycleWatchSupported = false;
        if (error instanceof SocketAckError && error.code === 'ForbiddenException') {
          this.stopLifecyclePolling();
          this.watchedSessionId = '';
          this.error.set(error.message || 'You are not allowed to open this class session.');
          this.loading.set(false);
          return;
        }
        this.startLifecyclePolling();
      });
  }

  private unwatchCurrentSession(): void {
    const sessionId = this.watchedSessionId;
    this.watchedSessionId = '';
    this.lifecycleWatchPending = false;
    this.lifecycleWatchSupported = false;
    if (sessionId) {
      void this.socket.emitAck('session:unwatch', { sessionId }).catch(() => undefined);
    }
  }

  private handleClassSessionLifecycleEvent(eventName: string, payload: unknown): void {
    const event = this.lifecycleEventFromUnknown(payload, this.lifecycleStatusFromEventName(eventName));
    if (!event || !this.isLifecycleEventForCurrentSession(event)) {
      return;
    }

    this.lifecycleSocketEventReceived = true;
    this.stopLifecyclePolling();

    if (event.status === 'live') {
      this.enterLiveSessionFromLifecycle(event);
      return;
    }

    if (event.status && this.isTerminalStatus(event.status)) {
      if (event.payload) {
        this.applyPayload(event.payload, false);
        return;
      }
      this.markSessionEnded(event.status);
      void this.leaveCurrentRoom();
      return;
    }

    this.refreshSessionSnapshot({ silent: true });
  }

  private enterLiveSessionFromLifecycle(event: ClassSessionLifecycleEvent): void {
    if (event.payload) {
      this.applyPayload(event.payload, false);
      return;
    }
    this.refreshSessionSnapshot({ silent: true });
  }

  private startLifecyclePolling(): void {
    if (this.destroyed || this.lifecycleSocketEventReceived || this.lifecycleWatchPending || this.lifecycleWatchSupported || this.lifecyclePollTimer) {
      return;
    }
    this.lifecyclePollTimer = setInterval(() => {
      this.refreshSessionSnapshot({ poll: true, silent: true });
    }, this.lifecyclePollIntervalMs);
  }

  private stopLifecyclePolling(): void {
    if (!this.lifecyclePollTimer) {
      return;
    }
    clearInterval(this.lifecyclePollTimer);
    this.lifecyclePollTimer = undefined;
    this.lifecyclePollInFlight = false;
  }

  private refreshSessionSnapshot(options: SessionSnapshotRefreshOptions = {}): void {
    if (this.destroyed || (options.poll && this.lifecyclePollInFlight)) {
      return;
    }

    const current = this.session();
    const routeSessionId = this.route.snapshot.queryParamMap.get('sessionId') ?? '';
    const routeBatchId = this.route.snapshot.queryParamMap.get('batchId') ?? '';
    const sessionId = routeSessionId || (!routeBatchId ? current?.sessionId ?? '' : '');
    const batchId = routeBatchId || current?.batchId || '';
    const request = sessionId && batchId ? this.classSessions.getSession(sessionId, batchId) : batchId ? this.classSessions.getCurrentForBatch(batchId) : null;
    if (!request) {
      return;
    }

    if (options.poll) {
      this.lifecyclePollInFlight = true;
    }

    const subscription = request.subscribe({
      next: (payload) => {
        if (options.preserveLocalTerminal && this.isTerminalStatus(current?.status) && payload.status === 'live') {
          return;
        }
        if (options.allowMediaJoin && options.forceMediaRejoin && this.joinedRoomId && payload.status === 'live' && payload.canJoin) {
          this.joinSession(payload.sessionId, payload.batchId, false, Boolean(options.forceMediaRejoin));
          return;
        }
        this.applyPayload(payload, false, Boolean(options.forceMediaRejoin));
      },
      error: (error) => {
        if (!options.silent) {
          this.applyError(error);
        }
      }
    });
    if (options.poll) {
      subscription.add(() => {
        this.lifecyclePollInFlight = false;
      });
    }
  }

  private handleClassroomRoomClosed(roomId: string): void {
    if (!this.isCurrentRoom(roomId)) {
      return;
    }
    this.mediaError.set('The class session has ended.');
    this.markSessionEnded('completed');
    void this.leaveCurrentRoom();
    this.refreshSessionSnapshot({ preserveLocalTerminal: true, silent: true });
  }

  private markSessionEnded(status: TerminalClassSessionStatus): void {
    this.stopLifecyclePolling();
    this.joiningMedia.set(false);
    this.publishingStudentMedia.set(false);
    this.refreshingDevices.set(false);
    this.switchingAudioDevice.set(false);
    this.switchingVideoDevice.set(false);
    this.updatingHandRaise.set(false);
    this.clearWhiteboardControlState();
    const current = this.session();
    if (!current) {
      return;
    }
    this.session.set({
      ...current,
      status,
      canJoin: false,
      ...(status === 'completed' ? { completedAt: current.completedAt ?? new Date().toISOString() } : {})
    });
  }

  private lifecycleEventFromUnknown(value: unknown, fallbackStatus?: ClassroomPayload['status']): ClassSessionLifecycleEvent | null {
    const record = this.recordFromUnknown(value);
    if (!record) {
      return null;
    }
    const nested =
      this.recordFromUnknown(record['payload']) ??
      this.recordFromUnknown(record['data']) ??
      this.recordFromUnknown(record['session']) ??
      this.recordFromUnknown(record['classSession']);
    const source = nested ?? record;
    const payload = this.classroomPayloadFromUnknown(source) ?? this.classroomPayloadFromUnknown(record);
    const status = payload?.status ?? this.lifecycleStatusFromUnknown(source['status']) ?? this.lifecycleStatusFromUnknown(record['status']) ?? fallbackStatus;
    const event: ClassSessionLifecycleEvent = {
      sessionId: payload?.sessionId ?? this.stringFromUnknown(source['sessionId']) ?? this.stringFromUnknown(source['id']) ?? this.stringFromUnknown(record['sessionId']),
      batchId: payload?.batchId ?? this.stringFromUnknown(source['batchId']) ?? this.stringFromUnknown(record['batchId']),
      roomId: payload?.roomId ?? this.stringFromUnknown(source['roomId']) ?? this.stringFromUnknown(record['roomId']),
      status,
      ...(payload ? { payload } : {})
    };
    if (!event.sessionId && !event.batchId && !event.roomId) {
      return null;
    }
    return event;
  }

  private isLifecycleEventForCurrentSession(event: ClassSessionLifecycleEvent): boolean {
    const current = this.session();
    const routeSessionId = this.route.snapshot.queryParamMap.get('sessionId') ?? '';
    const routeBatchId = this.route.snapshot.queryParamMap.get('batchId') ?? '';
    if (!current && !routeSessionId && !routeBatchId) {
      return false;
    }
    if (event.sessionId && routeSessionId && event.sessionId !== routeSessionId) {
      return false;
    }
    if (event.sessionId && current?.sessionId && event.sessionId !== current.sessionId) {
      return false;
    }
    if (event.batchId && routeBatchId && event.batchId !== routeBatchId) {
      return false;
    }
    if (event.batchId && current?.batchId && event.batchId !== current.batchId) {
      return false;
    }
    if (!event.sessionId && !event.batchId && event.roomId && event.roomId !== current?.roomId && event.roomId !== this.joinedRoomId) {
      return false;
    }
    return true;
  }

  private classroomPayloadFromUnknown(value: unknown): ClassroomPayload | null {
    const record = this.recordFromUnknown(value);
    if (!record || !Array.isArray(record['participants'])) {
      return null;
    }
    if (!this.stringFromUnknown(record['sessionId']) || !this.stringFromUnknown(record['batchId']) || !this.lifecycleStatusFromUnknown(record['status'])) {
      return null;
    }
    return value as ClassroomPayload;
  }

  private lifecycleStatusFromEventName(eventName: string): ClassroomPayload['status'] | undefined {
    if (eventName.endsWith(':started')) {
      return 'live';
    }
    if (eventName.endsWith(':ended')) {
      return 'completed';
    }
    return undefined;
  }

  private lifecycleStatusFromUnknown(value: unknown): ClassroomPayload['status'] | undefined {
    return value === 'scheduled' || value === 'live' || value === 'completed' || value === 'cancelled' ? value : undefined;
  }

  private isTerminalStatus(status: ClassroomPayload['status'] | null | undefined): status is TerminalClassSessionStatus {
    return status === 'completed' || status === 'cancelled';
  }

  private recordFromUnknown(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  }

  private stringFromUnknown(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined;
  }

  private applyProducerEvent(producer: Producer): void {
    if (!this.isCurrentRoom(producer.roomId)) {
      return;
    }
    this.store.upsertProducer(producer);
    if (this.isLocalStudentMediaProducer(producer)) {
      this.applyLocalProducerStatusEvent(producer);
      return;
    }
    if (producer.status !== 'live') {
      this.cleanupRemoteProducer(producer.id);
      return;
    }
    void this.consumeTeacherProducer(producer);
  }

  private applyConsumerEvent(consumer: Consumer): void {
    if (!this.isCurrentRoom(consumer.roomId)) {
      return;
    }
    this.consumerProducerIds.set(consumer.id, consumer.producerId);
    this.store.upsertConsumer(consumer);
    if (consumer.status === 'closed') {
      this.cleanupRemoteProducer(consumer.producerId);
    }
  }

  private applyConsumerLayerEvent(event: Parameters<ServerToClientEvents['consumer:layers-changed']>[0]): void {
    if (this.isCurrentRoom(event.roomId)) {
      this.store.applyConsumerLayerEvent(event);
    }
  }

  private async consumeAvailableTeacherProducers(): Promise<void> {
    const room = this.store.room();
    if (!room || !this.isCurrentRoom(room.id)) {
      return;
    }
    await Promise.all(room.producers.filter((producer) => this.isTeacherMediaProducer(producer)).map((producer) => this.consumeTeacherProducer(producer)));
  }

  private async consumeTeacherProducer(producer: Producer): Promise<void> {
    if (!this.isTeacherMediaProducer(producer) || !this.remoteWebRtc.consumeProducer) {
      return;
    }
    if (this.consumedProducerIds.has(producer.id) || this.pendingProducerIds.has(producer.id)) {
      return;
    }
    this.pendingProducerIds.add(producer.id);
    try {
      const result = await this.remoteWebRtc.consumeProducer(producer.roomId, producer);
      const stream = this.streamFromConsumeResult(result);
      if (stream) {
        this.returnedRemoteStreams.update((streams) => ({ ...streams, [producer.id]: stream }));
      }
      this.consumedProducerIds.add(producer.id);
      if (this.streamForProducer(producer.id)) {
        this.clearTeacherMediaWatchdog(producer.id);
      } else {
        this.scheduleTeacherMediaWatchdog(producer);
      }
    } catch (error) {
      this.mediaError.set(this.mediaRecoveryError()?.message ?? (error instanceof Error ? error.message : 'Unable to connect teacher media.'));
    } finally {
      this.pendingProducerIds.delete(producer.id);
    }
  }

  private scheduleTeacherMediaWatchdog(producer: Producer): void {
    this.clearTeacherMediaWatchdog(producer.id, false);
    const timer = setTimeout(() => {
      this.teacherMediaWatchdogs.delete(producer.id);
      if (this.destroyed || !this.isTeacherMediaProducer(producer)) {
        return;
      }
      if (this.streamForProducer(producer.id)) {
        this.teacherMediaRetryCounts.delete(producer.id);
        return;
      }
      const nextRetryCount = (this.teacherMediaRetryCounts.get(producer.id) ?? 0) + 1;
      this.teacherMediaRetryCounts.set(producer.id, nextRetryCount);
      this.cleanupRemoteProducer(producer.id, { resetRetry: false });
      if (nextRetryCount > TEACHER_MEDIA_STREAM_MAX_RETRIES) {
        this.mediaError.set(producer.kind === 'screen' ? 'Teacher shared content could not load. Wait for the teacher to share again.' : 'Teacher camera could not load. Wait for the teacher to retry camera.');
        return;
      }
      this.mediaError.set(producer.kind === 'screen' ? 'Teacher shared content is taking longer than expected. Retrying...' : 'Teacher camera is taking longer than expected. Retrying...');
      void this.consumeTeacherProducer(producer);
    }, TEACHER_MEDIA_STREAM_TIMEOUT_MS);
    this.teacherMediaWatchdogs.set(producer.id, timer);
  }

  private clearTeacherMediaWatchdog(producerId: string, resetRetry = true): void {
    const timer = this.teacherMediaWatchdogs.get(producerId);
    if (timer) {
      clearTimeout(timer);
      this.teacherMediaWatchdogs.delete(producerId);
    }
    if (resetRetry) {
      this.teacherMediaRetryCounts.delete(producerId);
    }
  }

  private clearTeacherMediaWatchdogs(): void {
    for (const timer of this.teacherMediaWatchdogs.values()) {
      clearTimeout(timer);
    }
    this.teacherMediaWatchdogs.clear();
    this.teacherMediaRetryCounts.clear();
  }

  private async publishEnabledStudentMedia(payload: ClassroomPayload): Promise<void> {
    if (this.publishingStudentMedia() || !this.canPublishInRoom(payload)) {
      return;
    }
    const kinds: ModeratedStudentMediaKind[] = [
      ...(this.localAudioEnabled() && !this.teacherDisabledAudio() && this.studentCanSelfUnmute() ? (['audio'] as const) : []),
      ...(this.localVideoEnabled() && !this.teacherDisabledVideo() && this.studentCanSelfStartCamera() ? (['video'] as const) : [])
    ];
    if (!kinds.length) {
      return;
    }
    this.publishingStudentMedia.set(true);
    this.localMediaError.set('');
    try {
      for (const kind of kinds) {
        try {
          await this.publishStudentMediaKind(payload, kind);
        } catch (error) {
          this.setLocalMediaKindState(kind, false);
          this.setLocalTracksEnabled(kind, false);
          this.stopLocalTrackKind(kind);
          this.localMediaError.set(this.mediaRecoveryError()?.message ?? this.deviceErrorMessage(error, kind === 'audio' ? 'Unable to publish your microphone.' : 'Unable to publish your camera.'));
        }
      }
    } finally {
      this.publishingStudentMedia.set(false);
    }
  }

  private addLocalProducer(producer: Producer): void {
    this.store.upsertProducer(producer);
    this.localProducerIds.update((producerIds) => (producerIds.includes(producer.id) ? producerIds : [...producerIds, producer.id]));
  }

  private async setStudentMediaKindEnabled(kind: ModeratedStudentMediaKind, enabled: boolean): Promise<void> {
    if (enabled && !this.canSelfEnableMediaKind(kind)) {
      this.localMediaError.set(kind === 'audio' ? 'Microphone self-unmute is disabled for this class.' : 'Camera self-start is disabled for this class.');
      return;
    }
    if (enabled && this.isTeacherDisabledKind(kind)) {
      this.showTeacherDisabledMessage(kind);
      return;
    }
    this.localMediaError.set('');

    if (!enabled) {
      const wasEnabled = this.localMediaKindEnabled(kind);
      this.setLocalTracksEnabled(kind, false);
      try {
        await this.setLocalProducerKindStatus(kind, false);
        this.setLocalMediaKindState(kind, false);
        this.patchLocalParticipantMedia(kind, false);
      } catch (error) {
        this.setLocalTracksEnabled(kind, wasEnabled);
        this.setLocalMediaKindState(kind, wasEnabled);
        this.patchLocalParticipantMedia(kind, wasEnabled);
        this.localMediaError.set(this.mediaRecoveryError()?.message ?? this.deviceErrorMessage(error, kind === 'audio' ? 'Unable to turn off your microphone.' : 'Unable to turn off your camera.'));
      }
      return;
    }

    try {
      this.setLocalMediaKindState(kind, true);
      await this.ensureLocalTrack(kind);
      this.setLocalTracksEnabled(kind, true);
      await this.publishOrResumeStudentMediaKind(kind);
      this.patchLocalParticipantMedia(kind, true);
    } catch (error) {
      this.setLocalMediaKindState(kind, false);
      this.setLocalTracksEnabled(kind, false);
      this.stopLocalTrackKind(kind);
      this.localMediaError.set(this.mediaRecoveryError()?.message ?? this.deviceErrorMessage(error, kind === 'audio' ? 'Unable to start your microphone.' : 'Unable to start your camera.'));
    }
  }

  private async publishOrResumeStudentMediaKind(kind: ModeratedStudentMediaKind): Promise<void> {
    if (this.isTeacherDisabledKind(kind) || !this.localMediaKindEnabled(kind)) {
      return;
    }
    if (!this.canSelfEnableMediaKind(kind)) {
      return;
    }
    const payload = this.session();
    if (!payload || !this.canPublishInRoom(payload)) {
      return;
    }
    const producer = this.localProducerForKind(kind);
    if (producer && producer.status !== 'closed') {
      await this.setLocalProducerKindStatus(kind, true);
      return;
    }
    this.publishingStudentMedia.set(true);
    this.localMediaError.set('');
    try {
      await this.publishStudentMediaKind(payload, kind);
    } catch (error) {
      this.setLocalMediaKindState(kind, false);
      this.setLocalTracksEnabled(kind, false);
      this.stopLocalTrackKind(kind);
      this.localMediaError.set(this.mediaRecoveryError()?.message ?? this.deviceErrorMessage(error, kind === 'audio' ? 'Unable to publish your microphone.' : 'Unable to publish your camera.'));
    } finally {
      this.publishingStudentMedia.set(false);
    }
  }

  private async publishStudentMediaKind(payload: ClassroomPayload, kind: ModeratedStudentMediaKind): Promise<void> {
    if (!this.canPublishInRoom(payload) || this.isTeacherDisabledKind(kind) || !this.localMediaKindEnabled(kind) || !this.canSelfEnableMediaKind(kind)) {
      return;
    }
    const existingProducer = this.localProducerForKind(kind);
    if (existingProducer && existingProducer.status !== 'closed') {
      await this.setLocalProducerKindStatus(kind, true);
      return;
    }
    let producer: Producer | null = null;
    try {
      const stream = await this.ensureLocalTrack(kind);
      const transport = await this.webrtc.preparePeer(payload.roomId);
      producer = await this.webrtc.publish(payload.roomId, transport, kind, stream);
      this.addLocalProducer(producer);
      this.applyProducerPolicyNotice(producer);
      this.patchLocalParticipantMedia(kind, true);
    } catch (error) {
      await this.closeStudentProducers(producer?.id ? [producer.id] : []);
      throw error;
    }
  }

  private canPublishInRoom(payload: ClassroomPayload): boolean {
    return Boolean(payload.roomId && payload.status === 'live' && this.session()?.status === 'live' && payload.canJoin && this.joinedRoomId === payload.roomId);
  }

  private async ensureLocalTrack(kind: ModeratedStudentMediaKind): Promise<MediaStream> {
    const current = this.localStream();
    const existingTrack = current?.getTracks().find((track) => track.kind === kind && track.readyState === 'live');
    const selectedDeviceId = kind === 'audio' ? this.selectedAudioDeviceId() : this.selectedVideoDeviceId();
    const activeDeviceId = kind === 'audio' ? this.webrtc.activeAudioDeviceId() : this.webrtc.activeVideoDeviceId();
    const selectedDeviceChanged = Boolean(selectedDeviceId && selectedDeviceId !== activeDeviceId);
    if (current && existingTrack && !selectedDeviceChanged) {
      return current;
    }
    await this.startOrSwitchLocalTrack(kind, selectedDeviceId);
    const stream = this.localStream();
    const nextTrack = stream?.getTracks().find((track) => track.kind === kind && track.readyState === 'live');
    if (!stream || !nextTrack) {
      throw new Error(`No ${kind === 'audio' ? 'microphone' : 'camera'} track is available.`);
    }
    return stream;
  }

  private async startOrSwitchLocalTrack(kind: ModeratedStudentMediaKind, deviceId: string): Promise<void> {
    const switchDevice = kind === 'audio' ? this.deviceWebRtc.switchMicrophone : this.deviceWebRtc.switchCamera;
    const switching = kind === 'audio' ? this.switchingAudioDevice : this.switchingVideoDevice;
    const selectionKey = kind === 'audio' ? 'selectedAudioDeviceId' : 'selectedVideoDeviceId';
    const selectionFallback = kind === 'audio' ? this.selectedAudioDeviceFallback : this.selectedVideoDeviceFallback;
    if (!switchDevice) {
      throw new Error(`${kind === 'audio' ? 'Microphone' : 'Camera'} preview is not available yet.`);
    }
    switching.set(true);
    this.deviceError.set('');
    try {
      await switchDevice.call(this.deviceWebRtc, deviceId || null);
      this.writeDeviceSelection(selectionKey, selectionFallback, deviceId);
      this.applyLocalTrackState();
    } finally {
      switching.set(false);
    }
  }

  private localMediaKindEnabled(kind: ModeratedStudentMediaKind): boolean {
    return kind === 'audio' ? this.localAudioEnabled() : this.localVideoEnabled();
  }

  private canSelfEnableMediaKind(kind: ModeratedStudentMediaKind): boolean {
    return kind === 'audio' ? this.studentCanSelfUnmute() : this.studentCanSelfStartCamera();
  }

  private setLocalMediaKindState(kind: ModeratedStudentMediaKind, enabled: boolean): void {
    if (kind === 'audio') {
      this.localAudioEnabled.set(enabled);
      return;
    }
    this.localVideoEnabled.set(enabled);
  }

  private isTeacherDisabledKind(kind: ModeratedStudentMediaKind): boolean {
    return kind === 'audio' ? this.teacherDisabledAudio() : this.teacherDisabledVideo();
  }

  private localProducerForKind(kind: ModeratedStudentMediaKind): Producer | null {
    const room = this.store.room();
    const producerIds = new Set(this.localProducerIds());
    return (
      room?.producers.find((producer) => producerIds.has(producer.id) && producer.kind === kind && producer.status !== 'closed') ??
      null
    );
  }

  private localProducerIdsForKind(kind: ModeratedStudentMediaKind): string[] {
    const room = this.store.room();
    const producerIds = new Set(this.localProducerIds());
    return room?.producers.filter((producer) => producerIds.has(producer.id) && producer.kind === kind).map((producer) => producer.id) ?? [];
  }

  private stopLocalTrackKind(kind: ModeratedStudentMediaKind): void {
    const stream = this.localStream();
    if (!stream) {
      return;
    }
    const remainingTracks: MediaStreamTrack[] = [];
    for (const track of stream.getTracks()) {
      if (track.kind === kind) {
        track.stop();
      } else {
        remainingTracks.push(track);
      }
    }
    this.webrtc.localStream.set(remainingTracks.length ? new MediaStream(remainingTracks) : null);
    if (kind === 'audio') {
      this.webrtc.activeAudioDeviceId.set(null);
      return;
    }
    this.webrtc.activeVideoDeviceId.set(null);
  }

  private async setLocalProducerKindStatus(kind: Extract<Producer['kind'], 'audio' | 'video'>, live: boolean): Promise<void> {
    const room = this.store.room();
    const producerIds = new Set(this.localProducerIds());
    const nextStatus: Producer['status'] = live ? 'live' : 'paused';
    const producers =
      room?.producers.filter((producer) => producerIds.has(producer.id) && producer.kind === kind && producer.status !== 'closed' && producer.status !== nextStatus) ??
      [];
    if (!producers.length) {
      return;
    }

    try {
      await Promise.all(
        producers.map(async (producer) => {
          await this.socket.emitAck(live ? 'producer:resume' : 'producer:pause', { producerId: producer.id });
          this.store.upsertProducer({ ...producer, status: nextStatus });
        })
      );
    } catch (error) {
      this.localMediaError.set(this.mediaRecoveryError()?.message ?? this.deviceErrorMessage(error, live ? 'Unable to resume your media.' : 'Unable to pause your media.'));
      throw error;
    }
  }

  private forgetLocalProducer(producerId: string): void {
    this.localProducerIds.update((producerIds) => producerIds.filter((id) => id !== producerId));
  }

  private async closeStudentProducers(producerIds = this.localProducerIds()): Promise<void> {
    const uniqueProducerIds = [...new Set(producerIds)];
    this.localProducerIds.update((currentIds) => currentIds.filter((id) => !uniqueProducerIds.includes(id)));
    await Promise.all(
      uniqueProducerIds.map(async (producerId) => {
        try {
          await this.webrtc.closeProducer(producerId);
        } catch {
          // The room may already be closed or the socket may be gone during teardown.
        }
        this.store.removeProducer(producerId);
      })
    );
  }

  private async leaveCurrentRoom(options: { preserveMediaIntent?: boolean } = {}): Promise<void> {
    const roomId = this.joinedRoomId;
    this.joinedRoomId = '';
    this.stopActivityHeartbeat();
    await this.closeStudentProducers();
    this.cleanupLocalMediaLocally({ preserveMediaIntent: Boolean(options.preserveMediaIntent) });
    if (roomId && this.store.room()?.id === roomId) {
      this.store.room.set(null);
    }
    if (roomId) {
      await this.socket.emitAck('room:leave', { roomId }).catch(() => undefined);
    }
  }

  private cleanupLocalMediaLocally(options: { preserveMediaIntent?: boolean } = {}): void {
    this.localProducerIds.set([]);
    if (!options.preserveMediaIntent) {
      this.localAudioEnabled.set(false);
      this.localVideoEnabled.set(false);
      this.selectedAudioDeviceFallback.set('');
      this.selectedVideoDeviceFallback.set('');
    }
    this.publishingStudentMedia.set(false);
    this.refreshingDevices.set(false);
    this.switchingAudioDevice.set(false);
    this.switchingVideoDevice.set(false);
    this.updatingHandRaise.set(false);
    this.webrtc.resetRoomMedia();
    this.returnedRemoteStreams.set({});
    this.consumedProducerIds.clear();
    this.pendingProducerIds.clear();
    this.clearTeacherMediaWatchdogs();
    this.consumerProducerIds.clear();
    this.clearWhiteboardControlState();
  }

  private applyLocalTrackState(): void {
    this.setLocalTracksEnabled('audio', this.localAudioEnabled());
    this.setLocalTracksEnabled('video', this.localVideoEnabled());
  }

  private handleModerationSocketEvent(eventName: string, args: unknown[]): void {
    const command = this.teacherMediaDisableCommandFromUnknown(eventName, args);
    if (!command || !this.isTeacherMediaDisableForLocalStudent(command, { requireExplicitTarget: true })) {
      return;
    }
    void this.applyTeacherMediaDisable(command.kind, command.message);
  }

  private handleStudentMediaModerated(event: StudentMediaModerationEvent): void {
    if (!this.isTeacherMediaDisableForLocalStudent(event)) {
      return;
    }
    if (event.action === 'unmute-mic' || event.action === 'restore-camera') {
      this.applyTeacherMediaRestore(event.kind, event.message ?? this.teacherRestoredActionMessage(event.kind), event.permissions);
      return;
    }
    void this.applyTeacherMediaDisable(event.kind, event.message ?? this.teacherDisabledActionMessage(event.kind), { syncProducer: false });
  }

  protected whiteboardPermissionLabel(permissionLevel: WhiteboardPermissionLevel): string {
    switch (permissionLevel) {
      case 'draw':
        return 'Draw only';
      case 'annotate':
        return 'Annotate';
      case 'current_page_edit':
        return 'Current page edit';
      default:
        return 'View only';
    }
  }

  private isStudentWhiteboardCommandAllowed(command: WhiteboardCommand): boolean {
    const permissionLevel = this.whiteboardPermissionLevel();
    if (permissionLevel === 'view_only') {
      return false;
    }
    const permittedPageId = this.whiteboardPermittedPageId();
    if (permittedPageId && command.pageId !== permittedPageId) {
      return false;
    }
    if (command.type === 'clear') {
      return false;
    }
    if (command.type === 'delete') {
      return permissionLevel === 'current_page_edit';
    }
    if (command.type !== 'upsert') {
      return false;
    }
    const elementType = command.element.type;
    if (elementType === 'file') {
      return false;
    }
    if (permissionLevel === 'draw') {
      return elementType === 'stroke';
    }
    return ['stroke', 'shape', 'text', 'equation', 'graph', 'geometry', 'diagram'].includes(elementType);
  }

  private applyWhiteboardControlEvent(event: WhiteboardControlEvent): void {
    if (!this.isWhiteboardEventForCurrentRoom(event.roomId)) {
      return;
    }
    const localParticipantId = this.store.localParticipantId();
    const targetsLocalStudent = Boolean(localParticipantId && event.participantId === localParticipantId);
    if (event.granted && targetsLocalStudent) {
      const permissionLevel = event.permissionLevel ?? 'annotate';
      this.participantsOpen.set(false);
      this.materialsOpen.set(false);
      this.whiteboardControlGranted.set(true);
      this.whiteboardPermissionLevel.set(permissionLevel);
      this.whiteboardPermittedPageId.set(event.pageId ?? '');
      this.whiteboardDrawerOpen.set(true);
      this.whiteboardControlNotice.set(
        event.message ?? `Teacher allowed ${this.whiteboardPermissionLabel(permissionLevel).toLowerCase()} whiteboard control.`
      );
      window.setTimeout(() => this.flushPendingWhiteboardCommands(), 0);
      return;
    }
    if (!event.granted && (targetsLocalStudent || this.whiteboardControlGranted())) {
      this.clearWhiteboardControlState(event.message ?? event.reason ?? 'Whiteboard control was revoked.');
    }
  }

  private applyRemoteWhiteboardCommand(event: WhiteboardCommandEvent): void {
    if (!this.isWhiteboardEventForCurrentRoom(event.roomId) || event.participantId === this.store.localParticipantId() || !this.whiteboardControlGranted()) {
      return;
    }
    const command = this.normalizeWhiteboardCommand(event.command);
    const whiteboard = this.interactiveWhiteboard;
    if (!whiteboard) {
      this.pendingWhiteboardCommands.push(command);
      window.setTimeout(() => this.flushPendingWhiteboardCommands(), 0);
      return;
    }
    whiteboard.applyCommand(command);
  }

  private applyRemoteWhiteboardCursor(event: WhiteboardCursorEvent): void {
    if (!this.isWhiteboardEventForCurrentRoom(event.roomId) || event.cursor.participantId === this.store.localParticipantId() || !this.whiteboardControlGranted()) {
      return;
    }
    this.whiteboardCursors.update((cursors) => [
      ...cursors.filter((cursor) => cursor.participantId !== event.cursor.participantId),
      event.cursor
    ]);
    const previousTimer = this.whiteboardCursorTimers.get(event.cursor.participantId);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }
    const timer = setTimeout(() => {
      this.whiteboardCursors.update((cursors) => cursors.filter((cursor) => cursor.participantId !== event.cursor.participantId));
      this.whiteboardCursorTimers.delete(event.cursor.participantId);
    }, 1800);
    this.whiteboardCursorTimers.set(event.cursor.participantId, timer);
  }

  private flushPendingWhiteboardCommands(): void {
    const whiteboard = this.interactiveWhiteboard;
    if (!whiteboard || !this.pendingWhiteboardCommands.length) {
      return;
    }
    const commands = this.pendingWhiteboardCommands.splice(0);
    for (const command of commands) {
      whiteboard.applyCommand(command);
    }
  }

  private normalizeWhiteboardCommand(command: WhiteboardCommand | WireWhiteboardCommand): WhiteboardCommand {
    if (command.type === 'clear') {
      return { type: 'clear', ...(command.pageId ? { pageId: command.pageId } : {}) };
    }
    if (command.type === 'delete') {
      return { type: 'delete', elementId: command.elementId, ...(command.pageId ? { pageId: command.pageId } : {}) };
    }
    if (command.type !== 'upsert') {
      return { type: 'clear' };
    }
    return { type: 'upsert', element: command.element as LocalWhiteboardUpsertElement, ...(command.pageId ? { pageId: command.pageId } : {}) };
  }

  private toWireWhiteboardCommand(command: WhiteboardCommand): WireWhiteboardCommand {
    return this.normalizeWhiteboardCommand(command) as unknown as WireWhiteboardCommand;
  }

  private clearWhiteboardControlState(message = ''): void {
    this.whiteboardControlGranted.set(false);
    this.whiteboardPermissionLevel.set('view_only');
    this.whiteboardPermittedPageId.set('');
    this.whiteboardDrawerOpen.set(false);
    this.whiteboardControlNotice.set(message);
    this.pendingWhiteboardCommands = [];
    for (const timer of this.whiteboardCursorTimers.values()) {
      clearTimeout(timer);
    }
    this.whiteboardCursorTimers.clear();
    this.whiteboardCursors.set([]);
  }

  private isWhiteboardEventForCurrentRoom(roomId: string): boolean {
    return Boolean(roomId && (this.joinedRoomId === roomId || this.store.room()?.id === roomId || this.session()?.roomId === roomId));
  }

  private teacherMediaDisableCommandFromUnknown(eventName: string, args: unknown[]): TeacherMediaDisableCommand | null {
    const records = this.recordsFromUnknownArgs(args);
    const text = [
      eventName,
      ...records.flatMap((record) =>
        ['action', 'type', 'command', 'moderationAction', 'mediaAction', 'kind', 'mediaKind', 'device', 'reason'].map((key) => this.stringFromUnknown(record[key]) ?? '')
      )
    ]
      .join(' ')
      .toLowerCase();
    const kind = this.mediaKindFromModerationText(text);
    if (!kind) {
      return null;
    }
    return {
      kind,
      roomId: this.firstStringFromRecords(records, ['roomId']),
      participantId: this.firstStringFromRecords(records, ['participantId', 'targetParticipantId', 'targetId']),
      userId: this.firstStringFromRecords(records, ['userId', 'targetUserId']),
      message: this.firstStringFromRecords(records, ['message', 'reason'])
    };
  }

  private mediaKindFromModerationText(text: string): ModeratedStudentMediaKind | null {
    if (/(^|\W)(allow|enable|resume|restore|unmute)(\W|$)/.test(text)) {
      return null;
    }
    if (/(camera|video|disable-camera|stop-camera|camera-stop|camera-off)/.test(text)) {
      return 'video';
    }
    if (/(microphone|\bmic\b|audio|force-mute|\bmute\b|muted)/.test(text)) {
      return 'audio';
    }
    return null;
  }

  private recordsFromUnknownArgs(args: unknown[]): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    for (const value of args) {
      const record = this.recordFromUnknown(value);
      if (!record) {
        continue;
      }
      records.push(record);
      for (const key of ['payload', 'data', 'command', 'moderation', 'target', 'participant']) {
        const nested = this.recordFromUnknown(record[key]);
        if (nested) {
          records.push(nested);
        }
      }
    }
    return records;
  }

  private firstStringFromRecords(records: readonly Record<string, unknown>[], keys: readonly string[]): string | undefined {
    for (const record of records) {
      for (const key of keys) {
        const value = this.stringFromUnknown(record[key]);
        if (value) {
          return value;
        }
      }
    }
    return undefined;
  }

  private isTeacherMediaDisableForLocalStudent(
    command: TeacherMediaDisableCommand,
    options: { requireExplicitTarget?: boolean } = {}
  ): boolean {
    if (command.roomId && !this.isCurrentRoom(command.roomId)) {
      return false;
    }
    const localParticipant = this.localParticipant();
    const localParticipantId = this.store.localParticipantId();
    const hasExplicitTarget = Boolean(command.participantId || command.userId);
    if (options.requireExplicitTarget && !hasExplicitTarget) {
      return false;
    }
    if (command.participantId && (!localParticipantId || command.participantId !== localParticipantId)) {
      return false;
    }
    if (command.userId && (!localParticipant?.userId || command.userId !== localParticipant.userId)) {
      return false;
    }
    return Boolean(this.sessionLive() || this.joinedRoomId);
  }

  private async applyTeacherMediaDisable(
    kind: ModeratedStudentMediaKind,
    message = this.teacherDisabledActionMessage(kind),
    options: { syncProducer?: boolean } = {}
  ): Promise<void> {
    if (kind === 'audio') {
      this.teacherDisabledAudio.set(true);
      this.localAudioEnabled.set(false);
    } else {
      this.teacherDisabledVideo.set(true);
      this.localVideoEnabled.set(false);
    }
    this.teacherModerationNotice.set(message);
    this.setLocalTracksEnabled(kind, false);
    this.patchLocalParticipantMedia(kind, false);
    if (options.syncProducer === false) {
      return;
    }
    try {
      await this.setLocalProducerKindStatus(kind, false);
    } catch (error) {
      this.localMediaError.set(this.mediaRecoveryError()?.message ?? this.deviceErrorMessage(error, kind === 'audio' ? 'Unable to mute your microphone.' : 'Unable to stop your camera.'));
    }
  }

  private applyLocalParticipantMediaPatch(participantId: string, patch: unknown): void {
    if (!this.isLocalParticipantId(participantId)) {
      return;
    }
    const record = this.recordFromUnknown(patch);
    if (!record) {
      return;
    }
    if (record['audioEnabled'] === false) {
      void this.applyTeacherMediaDisable('audio');
    }
    if (record['videoEnabled'] === false) {
      void this.applyTeacherMediaDisable('video');
    }
    this.applyLocalParticipantPermissionsPatch(participantId, record['permissions']);
  }

  private applyLocalParticipantPermissionsPatch(participantId: string, permissions: unknown): void {
    if (!this.isLocalParticipantId(participantId)) {
      return;
    }
    const record = this.recordFromUnknown(permissions);
    if (!record) {
      return;
    }
    if (record['canPublishAudio'] === false) {
      void this.applyTeacherMediaDisable('audio');
    } else if (record['canPublishAudio'] === true) {
      this.applyTeacherMediaRestore('audio', this.teacherRestoredActionMessage('audio'), undefined, { showNotice: false });
    }
    if (record['canPublishVideo'] === false) {
      void this.applyTeacherMediaDisable('video');
    } else if (record['canPublishVideo'] === true) {
      this.applyTeacherMediaRestore('video', this.teacherRestoredActionMessage('video'), undefined, { showNotice: false });
    }
  }

  private applyLocalProducerStatusEvent(producer: Producer): void {
    if (producer.kind !== 'audio' && producer.kind !== 'video') {
      return;
    }
    if (producer.status === 'closed') {
      this.forgetLocalProducer(producer.id);
      this.setLocalMediaKindState(producer.kind, false);
      this.setLocalTracksEnabled(producer.kind, false);
      this.patchLocalParticipantMedia(producer.kind, false);
      return;
    }
    const enabled = producer.status === 'live' && !this.isTeacherDisabledKind(producer.kind);
    this.setLocalMediaKindState(producer.kind, enabled);
    this.setLocalTracksEnabled(producer.kind, enabled);
    this.patchLocalParticipantMedia(producer.kind, enabled);
  }

  private patchLocalParticipantMedia(kind: ModeratedStudentMediaKind, enabled: boolean): void {
    const participantId = this.store.localParticipantId();
    if (!participantId) {
      return;
    }
    this.store.patchParticipant(participantId, { [kind === 'audio' ? 'audioEnabled' : 'videoEnabled']: enabled } as Partial<Participant>);
  }

  private localParticipant(): Participant | null {
    const participantId = this.store.localParticipantId();
    return this.store.room()?.participants.find((participant) => participant.id === participantId) ?? null;
  }

  private syncTeacherModerationFromLocalParticipant(): void {
    const participant = this.localParticipant();
    if (!participant) {
      return;
    }
    this.applyLocalParticipantPermissionsPatch(participant.id, participant.permissions);
    this.applyLocalParticipantMediaPatch(participant.id, participant);
  }

  private syncLocalParticipantMediaState(): void {
    this.patchLocalParticipantMedia('audio', this.localAudioEnabled());
    this.patchLocalParticipantMedia('video', this.localVideoEnabled());
  }

  private isLocalParticipantId(participantId: string | null | undefined): boolean {
    return Boolean(participantId && this.store.localParticipantId() === participantId);
  }

  private isLocalStudentMediaProducer(producer: Producer): boolean {
    if (producer.kind !== 'audio' && producer.kind !== 'video') {
      return false;
    }
    const producerIds = new Set(this.localProducerIds());
    return producerIds.has(producer.id) || this.isLocalParticipantId(producer.participantId);
  }

  private showTeacherDisabledMessage(kind: ModeratedStudentMediaKind): void {
    this.teacherModerationNotice.set(this.teacherDisabledActionMessage(kind));
  }

  private teacherDisabledActionMessage(kind: ModeratedStudentMediaKind): string {
    return kind === 'audio' ? 'Teacher muted your microphone.' : 'Teacher stopped your camera.';
  }

  private applyTeacherMediaRestore(
    kind: ModeratedStudentMediaKind,
    message = this.teacherRestoredActionMessage(kind),
    permissions?: Participant['permissions'],
    options: { showNotice?: boolean } = {}
  ): void {
    if (kind === 'audio') {
      this.teacherDisabledAudio.set(false);
    } else {
      this.teacherDisabledVideo.set(false);
    }
    if (permissions) {
      const participantId = this.store.localParticipantId();
      if (participantId) {
        this.store.patchParticipant(participantId, { permissions } as Partial<Participant>);
      }
    }
    if (options.showNotice !== false) {
      this.teacherModerationNotice.set(message);
    } else if (!this.teacherDisabledAudio() && !this.teacherDisabledVideo()) {
      this.teacherModerationNotice.set('');
    }
  }

  private teacherRestoredActionMessage(kind: ModeratedStudentMediaKind): string {
    return kind === 'audio'
      ? 'Teacher allowed your microphone. Turn it on when you are ready.'
      : 'Teacher allowed your camera. Turn it on when you are ready.';
  }

  private resetTeacherModerationState(): void {
    this.teacherDisabledAudio.set(false);
    this.teacherDisabledVideo.set(false);
    this.teacherModerationNotice.set('');
  }

  private syncSelectedDevicesFromLocalStream(): void {
    const stream = this.localStream();
    if (stream) {
      this.syncSelectedDevicesFromStream(stream);
    }
  }

  private syncSelectedDevicesFromStream(stream: MediaStream): void {
    const audioDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId;
    const videoDeviceId = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (audioDeviceId) {
      this.writeDeviceSelection('selectedAudioDeviceId', this.selectedAudioDeviceFallback, audioDeviceId);
    }
    if (videoDeviceId) {
      this.writeDeviceSelection('selectedVideoDeviceId', this.selectedVideoDeviceFallback, videoDeviceId);
    }
  }

  private readDeviceSelection(selection: DeviceSelectionValue | undefined): string {
    if (typeof selection === 'function') {
      return selection() || '';
    }
    return selection ?? '';
  }

  private writeDeviceSelection(
    key: 'selectedAudioDeviceId' | 'selectedVideoDeviceId',
    fallback: WritableSignal<string>,
    deviceId: string
  ): void {
    fallback.set(deviceId);
    const selection = this.deviceWebRtc[key];
    if (typeof selection === 'function') {
      const writableSelection = selection as WritableSignal<string | null>;
      if (typeof writableSelection.set === 'function') {
        writableSelection.set(deviceId || null);
      }
      return;
    }
    if (selection !== undefined) {
      try {
        (this.deviceWebRtc as unknown as Record<typeof key, string>)[key] = deviceId;
      } catch {
        // Some WebRTC implementations expose selected devices as readonly values.
      }
    }
  }

  private setLocalTracksEnabled(kind: MediaStreamTrack['kind'], enabled: boolean): void {
    this.localStream()
      ?.getTracks()
      .filter((track) => track.kind === kind)
      .forEach((track) => {
        track.enabled = enabled;
      });
  }

  private applyProducerPolicyNotice(producer: { policyDecision?: { action: string; message: string } }): void {
    if (producer.policyDecision && producer.policyDecision.action !== 'allow') {
      this.localMediaError.set(producer.policyDecision.message);
    }
  }

  private deviceErrorMessage(error: unknown, fallback: string): string {
    if (error instanceof DOMException) {
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
        return 'Camera or microphone permission was blocked. Allow access in your browser, then rejoin the class.';
      }
      if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
        return 'No camera or microphone was found. Connect a device and refresh.';
      }
      if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
        return 'The selected device is already in use by another app.';
      }
      if (error.name === 'OverconstrainedError') {
        return 'The selected device is unavailable. Choose another device.';
      }
    }
    return error instanceof Error && error.message ? error.message : fallback;
  }

  private findTeacherParticipant(): Participant | null {
    const room = this.store.room();
    const teacherId = this.session()?.teacherId;
    if (!room || !this.isCurrentRoom(room.id)) {
      return null;
    }
    return (
      room.participants.find((participant) => Boolean(teacherId && participant.userId === teacherId)) ??
      room.participants.find((participant) => participant.role === 'HOST' || participant.role === 'CO_HOST') ??
      null
    );
  }

  private findTeacherProducer(kind: Producer['kind']): Producer | null {
    const room = this.store.room();
    if (!room || !this.isCurrentRoom(room.id)) {
      return null;
    }
    return (
      [...room.producers]
        .filter((producer) => producer.kind === kind && this.isTeacherMediaProducer(producer))
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null
    );
  }

  private sharedContentTitle(producer: Producer): string {
    const source = this.sharedContentSource(producer);
    if (source === 'whiteboard') {
      return 'Teacher whiteboard';
    }
    if (source === 'screen') {
      return 'Teacher screen';
    }
    return 'Teacher shared content';
  }

  private sharedContentStatusText(producer: Producer, state: 'connecting' | 'live'): string {
    const source = this.sharedContentSource(producer);
    if (state === 'connecting') {
      if (source === 'whiteboard') return 'Connecting to the teacher whiteboard.';
      if (source === 'screen') return 'Connecting to the teacher screen.';
      return 'Connecting to the teacher share.';
    }
    if (source === 'whiteboard') return 'Whiteboard live';
    if (source === 'screen') return 'Screen sharing';
    return 'Sharing content';
  }

  private sharedContentSource(producer: Producer): 'screen' | 'whiteboard' | undefined {
    return producer.source === 'whiteboard' || producer.source === 'screen' ? producer.source : undefined;
  }

  private isTeacherMediaProducer(producer: Producer): boolean {
    if (producer.status !== 'live' || !this.isCurrentRoom(producer.roomId)) {
      return false;
    }
    const room = this.store.room();
    const teacherId = this.session()?.teacherId;
    const participant = room?.participants.find((item) => item.id === producer.participantId);
    return producer.participantId === teacherId || this.isTeacherParticipant(participant);
  }

  private isTeacherParticipant(participant: Participant | null | undefined): boolean {
    if (!participant) {
      return false;
    }
    const teacherId = this.session()?.teacherId;
    return Boolean((teacherId && participant.userId === teacherId) || participant.role === 'HOST' || participant.role === 'CO_HOST');
  }

  private studentDisplayName(payload: ClassroomPayload): string {
    const user = this.auth.user();
    return (
      payload.participants.find((participant) => participant.role === 'student' && (!user?.id || participant.userId === user.id))?.displayName ??
      user?.name ??
      payload.participants.find((participant) => participant.role === 'student')?.displayName ??
      'Student'
    );
  }

  private roomParticipant(participant: Participant): StudentSessionParticipant {
    const isTeacher = this.isTeacherParticipant(participant);
    return {
      id: participant.id,
      name: participant.displayName,
      role: isTeacher ? 'Teacher' : 'Student',
      initials: this.initials(participant.displayName),
      speaking: isTeacher && participant.connected !== false && (participant.audioEnabled || participant.videoEnabled || participant.screenSharing),
      handRaised: participant.handRaised,
      allowedToSpeak: Boolean(participant.allowedToSpeak),
      reconnecting: isTeacher && participant.connected === false
    };
  }

  private streamForProducer(producerId: string | null | undefined): MediaStream | null {
    if (!producerId) {
      return null;
    }
    return this.streamFromRegistry(this.remoteWebRtc.remoteStreams?.(), producerId) ?? this.returnedRemoteStreams()[producerId] ?? null;
  }

  private streamFromRegistry(registry: RemoteStreamRegistry, producerId: string): MediaStream | null {
    if (!registry) {
      return null;
    }
    if (registry instanceof Map) {
      return this.streamFromUnknown(registry.get(producerId));
    }
    if (Array.isArray(registry)) {
      const entry = registry.find((item) => item.producerId === producerId || item.id === producerId);
      return this.streamFromUnknown(entry);
    }
    return this.streamFromUnknown((registry as Record<string, unknown>)[producerId]);
  }

  private streamFromConsumeResult(result: unknown): MediaStream | null {
    return this.streamFromUnknown(result);
  }

  private streamFromUnknown(value: unknown): MediaStream | null {
    if (this.isMediaStream(value)) {
      return value;
    }
    if (value && typeof value === 'object') {
      const entry = value as RemoteStreamEntry;
      return this.streamFromUnknown(entry.stream ?? entry.mediaStream);
    }
    return null;
  }

  private isMediaStream(value: unknown): value is MediaStream {
    return Boolean(value && typeof (value as MediaStream).getTracks === 'function');
  }

  private removeReturnedStream(producerId: string): void {
    this.returnedRemoteStreams.update((streams) => {
      const { [producerId]: _removed, ...remaining } = streams;
      return remaining;
    });
  }

  private cleanupRemovedRoomProducers(nextRoom: Room): void {
    const currentRoom = this.store.room();
    if (!currentRoom || !this.isCurrentRoom(currentRoom.id)) {
      return;
    }
    const nextProducerIds = new Set(nextRoom.producers.map((producer) => producer.id));
    for (const producer of currentRoom.producers) {
      if (!nextProducerIds.has(producer.id)) {
        this.cleanupRemoteProducer(producer.id);
        this.forgetLocalProducer(producer.id);
      }
    }
  }

  private cleanupRemoteProducer(producerId: string, options: { resetRetry?: boolean } = {}): void {
    this.clearTeacherMediaWatchdog(producerId, options.resetRetry !== false);
    this.webrtc.removeRemoteProducer(producerId);
    this.removeReturnedStream(producerId);
    this.consumedProducerIds.delete(producerId);
    this.pendingProducerIds.delete(producerId);
    for (const [consumerId, mappedProducerId] of this.consumerProducerIds.entries()) {
      if (mappedProducerId === producerId) {
        this.consumerProducerIds.delete(consumerId);
      }
    }
  }

  private isCurrentRoom(roomId: string | null | undefined): boolean {
    if (!roomId) {
      return false;
    }
    return this.session()?.roomId === roomId || this.joinedRoomId === roomId;
  }

  private followRoomOwnerRedirect(error: unknown, roomId: string, displayName: string): boolean {
    if (!(error instanceof SocketAckError) || error.code !== 'ROOM_REDIRECT') {
      return false;
    }
    const redirect = error.details as Partial<RoomOwnerRedirect> | undefined;
    if (!redirect?.ownerUrl || typeof window === 'undefined') {
      return false;
    }
    window.location.assign(buildRoomOwnerRedirectUrl(redirect.ownerUrl, roomId, { displayName, asViewer: false }));
    return true;
  }

  private initials(value: string): string {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : value.slice(0, 2);
    return letters.toUpperCase();
  }
}
