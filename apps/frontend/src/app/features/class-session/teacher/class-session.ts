import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { Consumer, Participant, Producer, ServerToClientEvents, StudentMediaModerationEvent } from '@native-sfu/contracts';
import { AuthService } from '../../../core/services/auth.service';
import { RoomStore } from '../../../core/services/room.store';
import { SocketService } from '../../../core/services/socket.service';
import { WebRtcService, type DeviceOption } from '../../../core/services/webrtc.service';
import { MediaStreamDirective } from '../../../shared/media-stream/media-stream.directive';
import { ClassSessionService, type ClassroomPayload } from '../class-session.service';
import { Whiteboard, type WhiteboardCursor } from '../../../shared/whiteboard/whiteboard';
import { SessionChat } from '../session-chat/session-chat';

interface SessionParticipant {
  id: string;
  name: string;
  role: 'Teacher' | 'Student' | 'Admin';
  initials: string;
  muted: boolean;
  cameraOff: boolean;
  screenSharing: boolean;
}

type DeviceIdSignal = (() => string | null) & { set(value: string | null): void };
type DeviceIdState = DeviceIdSignal | (() => string | null) | string | null | undefined;
type ParticipantMediaState = 'video' | 'audio-only' | 'muted' | 'camera-off' | 'local-hidden' | 'unavailable';
type ParticipantCardAction = 'mute' | 'camera' | 'visibility';
type ParticipantActionState = Partial<Record<ParticipantCardAction, boolean>>;

interface DeviceSwitchingWebRtc {
  refreshDevices(): Promise<void>;
  devices(): { audioInputs: DeviceOption[]; videoInputs: DeviceOption[] };
  selectedAudioDeviceId?: DeviceIdState;
  selectedVideoDeviceId?: DeviceIdState;
  switchMicrophone?: (deviceId: string | null) => Promise<void> | void;
  switchCamera?: (deviceId: string | null) => Promise<void> | void;
}

@Component({
  selector: 'sfu-teacher-class-session',
  standalone: true,
  imports: [RouterLink, SessionChat, Whiteboard, MediaStreamDirective],
  templateUrl: './class-session.html',
  styleUrl: './class-session.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class TeacherClassSession implements OnInit, OnDestroy {
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
  private readonly socketDisposers: Array<() => void> = [];
  private readonly localProducerIds = new Set<string>();
  private readonly consumedStudentProducerIds = new Set<string>();
  private readonly pendingStudentProducerIds = new Set<string>();
  private readonly consumerProducerIds = new Map<string, string>();

  protected readonly session = signal<ClassroomPayload | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly mediaNotice = signal('');
  protected readonly mediaError = signal('');
  protected readonly joiningRoom = signal(false);
  protected readonly roomJoined = signal(false);
  protected readonly publishingCamera = signal(false);
  protected readonly cameraPublished = signal(false);
  protected readonly publishingScreen = signal(false);
  protected readonly stoppingScreen = signal(false);
  protected readonly refreshingDevices = signal(false);
  protected readonly switchingAudioDevice = signal(false);
  protected readonly switchingVideoDevice = signal(false);
  protected readonly ending = signal(false);
  protected readonly participants = signal<SessionParticipant[]>([]);
  protected readonly studentCursors = signal<WhiteboardCursor[]>([]);
  protected readonly chatCollapsed = signal(false);
  protected readonly chatDisplayName = computed(() => this.auth.user()?.name ?? 'Teacher');
  protected readonly sidebarSplitPercent = signal(50);
  protected readonly resizingSidebar = signal(false);
  protected readonly locallyHiddenParticipantIds = signal<string[]>([]);
  protected readonly pendingParticipantActions = signal<Record<string, ParticipantActionState>>({});
  private readonly localSelectedAudioDeviceId = signal('');
  private readonly localSelectedVideoDeviceId = signal('');
  protected readonly sessionLive = computed(() => this.session()?.status === 'live');
  protected readonly audioInputDevices = computed(() => this.webrtc.devices().audioInputs);
  protected readonly videoInputDevices = computed(() => this.webrtc.devices().videoInputs);
  protected readonly selectedAudioDeviceId = computed(() => this.readSelectedDeviceId('audio'));
  protected readonly selectedVideoDeviceId = computed(() => this.readSelectedDeviceId('video'));
  protected readonly mediaBusy = computed(() =>
    this.joiningRoom() ||
    this.publishingCamera() ||
    this.publishingScreen() ||
    this.stoppingScreen() ||
    this.refreshingDevices() ||
    this.switchingAudioDevice() ||
    this.switchingVideoDevice()
  );
  protected readonly screenSharing = computed(() => Boolean(this.webrtc.screenStream()));
  protected readonly studentAudioStreams = computed(() =>
    this.webrtc.remoteStreams()
      .filter((remote) => remote.kind === 'audio' && this.isStudentParticipantId(remote.participantId) && !this.isParticipantMediaHidden(remote.participantId))
      .map((remote) => ({ producerId: remote.producerId, stream: remote.stream }))
  );
  protected readonly chatThreadParticipants = computed(() =>
    this.participants()
      .filter((participant) => participant.role === 'Student')
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
    if (this.stoppingScreen()) return 'Stopping screen share';
    if (this.switchingAudioDevice()) return 'Switching microphone';
    if (this.switchingVideoDevice()) return 'Switching camera';
    if (this.refreshingDevices()) return 'Refreshing devices';
    if (this.screenSharing()) return 'Screen sharing';
    if (this.mediaError()) return 'Media attention';
    if (this.cameraPublished()) return 'Camera live';
    return 'Media idle';
  });
  protected readonly sidebarRows = computed(() =>
    this.chatCollapsed()
      ? 'minmax(0, 1fr) auto'
      : `minmax(${this.minimumParticipantHeight}px, ${this.sidebarSplitPercent()}fr) ${this.dividerHeight}px minmax(${this.minimumChatHeight}px, ${100 - this.sidebarSplitPercent()}fr)`
  );

  ngOnInit(): void {
    this.bindSocketEvents();
    this.loadSession();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    for (const dispose of this.socketDisposers.splice(0)) {
      dispose();
    }
    void this.leaveCurrentRoom();
  }

  protected async muteStudentMicrophone(participantId: string): Promise<void> {
    const roomId = this.currentRoomId();
    if (!roomId || this.isParticipantActionPending(participantId, 'mute') || this.isParticipantMicTeacherDisabled(participantId)) {
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
    if (!roomId || this.isParticipantActionPending(participantId, 'mute') || !this.isParticipantMicTeacherDisabled(participantId)) {
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

  protected async stopStudentCamera(participantId: string): Promise<void> {
    const roomId = this.currentRoomId();
    if (!roomId || this.isParticipantActionPending(participantId, 'camera') || this.isParticipantCameraTeacherDisabled(participantId)) {
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
    if (!roomId || this.isParticipantActionPending(participantId, 'camera') || !this.isParticipantCameraTeacherDisabled(participantId)) {
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
    if (this.isParticipantActionPending(participantId, 'visibility')) {
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
        this.cleanupStudentParticipantMedia(participantId);
        this.mediaNotice.set('Student media hidden locally.');
      }
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to update local student media.');
    } finally {
      this.setParticipantActionPending(participantId, 'visibility', false);
    }
  }

  protected async toggleScreenShare(): Promise<void> {
    if (this.screenSharing()) {
      await this.stopScreenShare();
      return;
    }
    await this.shareScreen();
  }

  protected async refreshDevices(): Promise<void> {
    await this.refreshMediaDevices();
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
    if (nextDeviceId === this.selectedVideoDeviceId() || this.switchingVideoDevice()) {
      return;
    }

    this.switchingVideoDevice.set(true);
    this.mediaError.set('');
    try {
      if (typeof this.deviceWebRtc.switchCamera !== 'function') {
        throw new Error('Camera switching is waiting on WebRtcService support.');
      }
      await this.deviceWebRtc.switchCamera(nextDeviceId);
      this.setSelectedDeviceId('video', nextDeviceId);
      this.mediaNotice.set('Camera switched.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to switch camera.');
    } finally {
      this.switchingVideoDevice.set(false);
    }
  }

  protected endSession(): void {
    const session = this.session();
    if (!session || this.ending()) {
      return;
    }
    const confirmed = globalThis.confirm('End this live session for everyone?');
    if (!confirmed) {
      return;
    }
    this.ending.set(true);
    this.error.set('');
    this.classSessions.endSession(session.sessionId).subscribe({
      next: async (payload) => {
        this.session.set(payload);
        await this.leaveCurrentRoom();
        await this.router.navigate(['/teacher/dashboard/batches', payload.batchId]);
      },
      error: (error) => {
        this.error.set(this.classSessions.errorMessage(error));
        this.ending.set(false);
      }
    });
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
        if (payload.status === 'live' && payload.roomId) {
          void this.joinAndPublish(payload, { showLoading: true });
          return;
        }
        this.loading.set(false);
      },
      error: (error) => {
        this.error.set(this.classSessions.errorMessage(error));
        this.loading.set(false);
      }
    });
  }

  private applyPayload(payload: ClassroomPayload): void {
    this.session.set(payload);
    this.participants.set(payload.participants.map((participant) => this.classroomParticipantToCard(participant)));
  }

  private async joinAndPublish(payload: ClassroomPayload, options: { showLoading: boolean }): Promise<void> {
    if (!payload.roomId || payload.status !== 'live' || this.joiningRoom()) {
      return;
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
        return;
      }
      this.joinedRoomId = payload.roomId;
      this.roomJoined.set(true);
      this.store.setRoom(response.room);
      this.store.setLocalParticipant(response.participantId);
      this.syncParticipantsFromRoom();
      void this.consumeAvailableStudentProducers();
      this.joiningRoom.set(false);
      if (await this.publishCamera(payload.roomId)) {
        this.mediaNotice.set('Camera and audio are live.');
      }
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to join the live room.');
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
      const stream = await this.webrtc.startCamera(this.selectedAudioDeviceId() || undefined, this.selectedVideoDeviceId() || undefined);
      this.syncSelectedDevices(stream);
      const transport = await this.webrtc.preparePeer(roomId);
      audioProducer = await this.webrtc.publish(roomId, transport, 'audio', stream);
      this.addLocalProducer(audioProducer);
      videoProducer = await this.webrtc.publish(roomId, transport, 'video', stream);
      this.addLocalProducer(videoProducer);
      this.applyProducerPolicyNotice(audioProducer);
      this.applyProducerPolicyNotice(videoProducer);
      this.cameraPublished.set(true);
      return true;
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to publish teacher camera and audio.');
      await this.closeLocalProducers([audioProducer?.id, videoProducer?.id].filter((id): id is string => Boolean(id)));
      this.webrtc.stopCamera();
      this.cameraPublished.set(false);
      return false;
    } finally {
      this.publishingCamera.set(false);
    }
  }

  private async shareScreen(): Promise<void> {
    const roomId = this.joinedRoomId || this.session()?.roomId;
    if (!roomId || this.publishingScreen()) {
      return;
    }
    this.publishingScreen.set(true);
    this.mediaError.set('');
    try {
      const stream = await this.webrtc.startScreen();
      stream.getVideoTracks()[0]?.addEventListener('ended', () => void this.handleScreenTrackEnded(), { once: true });
      const transport = await this.webrtc.preparePeer(roomId);
      const producer = await this.webrtc.publish(roomId, transport, 'screen', stream);
      this.screenProducerId = producer.id;
      this.addLocalProducer(producer);
      this.applyProducerPolicyNotice(producer);
      this.mediaNotice.set('Screen sharing is live.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to share screen.');
      this.webrtc.stopScreen();
      this.screenProducerId = '';
    } finally {
      this.publishingScreen.set(false);
    }
  }

  private async stopScreenShare(): Promise<void> {
    if (this.stoppingScreen()) {
      return;
    }
    this.stoppingScreen.set(true);
    this.mediaError.set('');
    const producerId = this.screenProducerId;
    try {
      if (producerId) {
        await this.closeLocalProducers([producerId]);
      }
      this.mediaNotice.set('Screen sharing stopped.');
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to stop screen sharing on the server.');
    } finally {
      this.webrtc.stopScreen();
      this.screenProducerId = '';
      this.stoppingScreen.set(false);
      this.syncParticipantsFromRoom();
    }
  }

  private async handleScreenTrackEnded(): Promise<void> {
    if (!this.roomJoined() || !this.screenProducerId) {
      this.webrtc.stopScreen();
      return;
    }
    await this.stopScreenShare();
  }

  private async leaveCurrentRoom(): Promise<void> {
    const roomId = this.joinedRoomId;
    this.joinedRoomId = '';
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

  private async closeLocalProducers(producerIds = [...this.localProducerIds]): Promise<void> {
    const uniqueProducerIds = [...new Set(producerIds)];
    await Promise.all(
      uniqueProducerIds.map(async (producerId) => {
        try {
          if (this.realtimeSocket.connected) {
            await this.webrtc.closeProducer(producerId);
          }
        } catch {
          // The socket or room may already be gone during disconnect/end-session cleanup.
        }
        this.localProducerIds.delete(producerId);
        if (producerId === this.screenProducerId) {
          this.screenProducerId = '';
        }
        this.store.removeProducer(producerId);
      })
    );
  }

  private cleanupRoomMediaLocally(): void {
    this.screenProducerId = '';
    this.roomJoined.set(false);
    this.cameraPublished.set(false);
    this.publishingCamera.set(false);
    this.publishingScreen.set(false);
    this.stoppingScreen.set(false);
    this.refreshingDevices.set(false);
    this.switchingAudioDevice.set(false);
    this.switchingVideoDevice.set(false);
    this.localProducerIds.clear();
    this.consumedStudentProducerIds.clear();
    this.pendingStudentProducerIds.clear();
    this.consumerProducerIds.clear();
    this.locallyHiddenParticipantIds.set([]);
    this.pendingParticipantActions.set({});
    this.webrtc.resetRoomMedia();
  }

  private markSessionCompleted(): void {
    const current = this.session();
    if (!current || current.status === 'completed') {
      return;
    }
    this.session.set({
      ...current,
      status: 'completed',
      canJoin: false,
      completedAt: current.completedAt ?? new Date().toISOString()
    });
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
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to refresh camera and microphone list.');
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
    if (this.studentVideoStream(participantId)) {
      return 'video';
    }
    if (hasPausedVideoProducer || participant?.videoEnabled === false) {
      return 'camera-off';
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
        return 'Unavailable';
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

  private setParticipantMediaHidden(participantId: string, hidden: boolean): void {
    this.locallyHiddenParticipantIds.update((participantIds) => {
      if (hidden) {
        return participantIds.includes(participantId) ? participantIds : [...participantIds, participantId];
      }
      return participantIds.filter((id) => id !== participantId);
    });
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

  private updateParticipant(participantId: string, update: (participant: SessionParticipant) => SessionParticipant): void {
    this.participants.update((participants) =>
      participants.map((participant) => (participant.id === participantId ? update(participant) : participant))
    );
  }

  private bindSocketEvents(): void {
    this.bindSocketLifecycle();
    this.registerSocketHandler('room:updated', (room) => {
      if (!this.isCurrentRoom(room.id)) {
        return;
      }
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
        this.screenProducerId = '';
        this.localProducerIds.delete(producerId);
        this.webrtc.stopScreen();
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
    this.registerSocketHandler('room:closed', (roomId) => {
      if (roomId === this.joinedRoomId) {
        this.mediaError.set('This room has closed.');
        this.markSessionCompleted();
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
      if (!this.socketWasDisconnected) {
        return;
      }
      this.socketWasDisconnected = false;
      void this.restoreRoomAfterReconnect();
    };
    const handleDisconnect = () => {
      this.socketWasDisconnected = true;
      this.handleSocketDisconnect();
    };
    const handleConnectError = (error: Error) => {
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

  private handleSocketDisconnect(): void {
    if (this.destroyed || !this.joinedRoomId || !this.sessionLive()) {
      return;
    }

    const wasScreenSharing = Boolean(this.screenProducerId || this.screenSharing());
    this.mediaError.set('Connection lost. Reconnecting to the live room...');
    if (wasScreenSharing) {
      this.mediaNotice.set('Screen sharing stopped. Start sharing again after reconnecting.');
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
        this.reconnectingRoom = false;
        this.applyPayload(payload);
        if (payload.status === 'live' && payload.roomId) {
          void this.joinAndPublish(payload, { showLoading: false });
          return;
        }
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
    return {
      id: participant.id,
      name: participant.displayName,
      role: participant.role === 'student' ? 'Student' : participant.role === 'admin' ? 'Admin' : 'Teacher',
      initials: this.initials(participant.displayName),
      muted: false,
      cameraOff: false,
      screenSharing: false
    };
  }

  private roomParticipantToCard(participant: Participant): SessionParticipant {
    return {
      id: participant.id,
      name: participant.displayName,
      role: participant.role === 'HOST' || participant.role === 'CO_HOST' ? 'Teacher' : 'Student',
      initials: this.initials(participant.displayName),
      muted: !participant.audioEnabled,
      cameraOff: !participant.videoEnabled,
      screenSharing: participant.screenSharing
    };
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
    if (!this.isStudentMediaProducer(producer) || this.isParticipantMediaHidden(producer.participantId)) {
      return;
    }
    if (this.consumedStudentProducerIds.has(producer.id) || this.pendingStudentProducerIds.has(producer.id)) {
      return;
    }
    this.pendingStudentProducerIds.add(producer.id);
    try {
      const consumer = await this.webrtc.consumeProducer(producer.roomId, producer);
      if (!this.isStudentMediaProducer(producer) || this.isParticipantMediaHidden(producer.participantId)) {
        this.cleanupStudentProducer(producer.id);
        return;
      }
      if (consumer) {
        this.consumerProducerIds.set(consumer.id, producer.id);
        this.store.upsertConsumer(consumer);
      }
      this.consumedStudentProducerIds.add(producer.id);
    } catch (error) {
      this.mediaError.set(error instanceof Error ? error.message : 'Unable to connect student media.');
    } finally {
      this.pendingStudentProducerIds.delete(producer.id);
    }
  }

  private isStudentMediaProducer(producer: Producer): boolean {
    if (producer.status !== 'live' || !this.isCurrentRoom(producer.roomId) || (producer.kind !== 'audio' && producer.kind !== 'video')) {
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

  private cleanupStudentParticipantMedia(participantId: string): void {
    for (const producer of this.store.room()?.producers.filter((item) => item.participantId === participantId) ?? []) {
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

  private initials(value: string): string {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    const letters = parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : value.slice(0, 2);
    return letters.toUpperCase();
  }
}
