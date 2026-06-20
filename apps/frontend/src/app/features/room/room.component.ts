import { ChangeDetectionStrategy, Component, computed, OnDestroy, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import type {
  ChatMessage,
  Participant,
  RoomFailureEvent,
  RoomMediaProfileId,
  RoomOwnerRedirect,
  RoomRecoveryActionType,
  ServerToClientEvents
} from '@native-sfu/contracts';
import { API_BASE_URL, buildRoomOwnerRedirectUrl } from '../../core/services/app-environment';
import { RoomStore } from '../../core/services/room.store';
import { SocketAckError, SocketService } from '../../core/services/socket.service';
import { WebRtcService } from '../../core/services/webrtc.service';
import { ChatPanelComponent } from './components/chat-panel/chat-panel.component';
import { DeviceSelectorComponent } from './components/device-selector/device-selector.component';
import { HostControlsComponent } from './components/host-controls/host-controls.component';
import { NetworkIndicatorComponent } from './components/network-indicator/network-indicator.component';
import { ParticipantsPanelComponent } from './components/participants-panel/participants-panel.component';
import { RecordingControlsComponent } from './components/recording-controls/recording-controls.component';
import { VideoGridComponent } from './components/video-grid/video-grid.component';
import { WaitingRoomComponent } from './components/waiting-room/waiting-room.component';

@Component({
  selector: 'sfu-room',
  standalone: true,
  imports: [
    ChatPanelComponent,
    DeviceSelectorComponent,
    HostControlsComponent,
    NetworkIndicatorComponent,
    ParticipantsPanelComponent,
    RecordingControlsComponent,
    VideoGridComponent,
    WaitingRoomComponent
  ],
  template: `
    @if (room(); as currentRoom) {
      <main class="room-shell">
        <header class="topbar">
          <div>
            <p class="eyebrow">Room</p>
            <h1>{{ currentRoom.name }}</h1>
          </div>
          <div class="room-meta">
            <code>{{ currentRoom.id }}</code>
            <sfu-network-indicator [score]="webrtc.networkScore()" />
          </div>
          @if (qualitySummary(); as summary) {
            <div class="quality-strip">
              <span class="quality-chip" [class.warn]="summary.health === 'degraded'" [class.critical]="summary.health === 'critical'">
                {{ summary.health }}
              </span>
              <span class="quality-chip">{{ summary.profile.label }}</span>
              <span class="quality-chip">{{ summary.congestionState }}</span>
              <span class="quality-chip">{{ summary.protections.join.action }} joins</span>
              <span class="quality-chip">{{ summary.protections.publish.action }} publishing</span>
            </div>
          }
        </header>

        <section class="stage">
          <sfu-video-grid
            [participants]="currentRoom.participants"
            [producers]="currentRoom.producers"
            [localParticipantId]="store.localParticipantId()"
            [localStream]="webrtc.localStream()"
          />
        </section>

        <section class="control-strip">
          <div class="toolbar">
            <button class="icon-button" type="button" title="Toggle microphone" (click)="toggleAudio()">A</button>
            <button class="icon-button" type="button" title="Toggle camera" (click)="toggleVideo()">V</button>
            <button type="button" (click)="publishCamera()" [disabled]="publishing()">Publish</button>
            <button type="button" (click)="toggleScreen()">{{ webrtc.screenStream() ? 'Stop screen' : 'Share screen' }}</button>
            <button class="danger" type="button" (click)="leave()">Leave</button>
          </div>
          <sfu-device-selector
            [audioInputs]="webrtc.devices().audioInputs"
            [videoInputs]="webrtc.devices().videoInputs"
            [audioDeviceId]="audioDeviceId()"
            [videoDeviceId]="videoDeviceId()"
            (audioDeviceIdChange)="audioDeviceId.set($event)"
            (videoDeviceIdChange)="videoDeviceId.set($event)"
          />
        </section>

        <section class="side-workspace">
          <div class="panel">
            <sfu-participants-panel
              [participants]="currentRoom.participants"
              [localParticipantId]="store.localParticipantId()"
              (mute)="mute($event)"
              (kick)="kick($event)"
            />
          </div>
          <div class="panel">
            <sfu-chat-panel [messages]="store.messages()" [participants]="currentRoom.participants" (sendMessage)="sendMessage($event)" />
          </div>
          <div class="panel">
            <sfu-host-controls
              [canManageRoom]="canManageRoom()"
              [activeProfileId]="currentRoom.mediaProfile.id"
              [profileUpdating]="profileUpdating()"
              [summary]="qualitySummary()"
              [incidentState]="incidentState()"
              [incidentTimeline]="incidentTimeline()"
              [snapshotHistory]="snapshotHistory()"
              (profileChange)="updateRoomMediaProfile($event)"
              (recoveryAction)="runRecoveryAction($event.action, $event.reason)"
              (lock)="lock()"
              (unlock)="unlock()"
              (close)="closeRoom()"
            />
            <sfu-recording-controls [isHost]="canManageRoom()" [recording]="recording()" (start)="startRecording()" (stop)="stopRecording()" />
            @if (canManageRoom()) {
              <sfu-waiting-room [pending]="pendingParticipants()" (admit)="admit($event)" (reject)="reject($event)" />
            }
          </div>
        </section>

        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
      </main>
    } @else {
      <main class="empty">
        <h1>No active room</h1>
        <button class="primary" type="button" (click)="router.navigate(['/sfu-forms'])">Open SFU forms</button>
      </main>
    }
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .room-shell {
        min-height: 100vh;
        display: grid;
        grid-template-rows: auto minmax(300px, 1fr) auto minmax(260px, 38vh);
        gap: 12px;
        padding: 16px;
        background:
          linear-gradient(180deg, var(--bg-start), var(--bg) 320px),
          var(--bg);
      }

      .topbar,
      .control-strip,
      .side-workspace {
        display: grid;
        gap: 12px;
      }

      .topbar {
        grid-template-columns: 1fr auto;
        align-items: end;
        border-bottom: 1px solid var(--line);
        padding-bottom: 10px;
      }

      h1,
      p {
        margin: 0;
      }

      h1 {
        font-size: 26px;
      }

      .eyebrow {
        color: var(--accent);
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
      }

      .room-meta {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .quality-strip {
        grid-column: 1 / -1;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .quality-chip {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 4px 10px;
        border: 1px solid var(--line);
        background: color-mix(in srgb, var(--panel-elevated) 84%, white 16%);
        font-size: 12px;
        font-weight: 700;
      }

      .quality-chip.warn {
        border-color: var(--warning);
        background: color-mix(in srgb, var(--warning) 22%, var(--panel-elevated) 78%);
      }

      .quality-chip.critical {
        border-color: var(--danger);
        background: color-mix(in srgb, var(--danger) 18%, var(--panel-elevated) 82%);
      }

      code {
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 6px;
        padding: 6px 8px;
        color: var(--muted);
      }

      .stage {
        min-height: 0;
      }

      .control-strip {
        grid-template-columns: minmax(300px, auto) minmax(300px, 1fr);
        align-items: start;
        border-top: 1px solid var(--line);
        border-bottom: 1px solid var(--line);
        padding: 10px 0;
      }

      .side-workspace {
        min-height: 0;
        grid-template-columns: 320px 1fr 320px;
      }

      .panel {
        min-height: 0;
        overflow: auto;
        border: 1px solid var(--line-soft);
        border-radius: var(--radius);
        background: var(--panel-elevated);
        padding: 12px;
        box-shadow: var(--shadow-sm);
      }

      .error {
        color: var(--danger);
        font-weight: 700;
      }

      .empty {
        min-height: 100vh;
        display: grid;
        place-content: center;
        gap: 16px;
      }

      @media (max-width: 980px) {
        .room-shell {
          grid-template-rows: auto minmax(300px, 50vh) auto auto;
        }

        .topbar,
        .control-strip,
        .side-workspace {
          grid-template-columns: 1fr;
        }
      }
    `
  ]
})
export class RoomComponent implements OnInit, OnDestroy {
  readonly room = this.store.room;
  readonly qualitySummary = this.store.roomQualitySummary;
  readonly incidentState = this.store.roomIncidentState;
  readonly incidentTimeline = this.store.roomIncidentTimeline;
  readonly snapshotHistory = this.store.roomSnapshotHistory;
  readonly publishing = signal(false);
  readonly error = signal('');
  readonly recording = signal(false);
  readonly currentRecordingId = signal<string | null>(null);
  readonly audioDeviceId = signal('');
  readonly videoDeviceId = signal('');
  readonly profileUpdating = signal(false);

  readonly localParticipant = computed(() => this.room()?.participants.find((participant) => participant.id === this.store.localParticipantId()) ?? null);
  readonly canManageRoom = computed(() => {
    const role = this.localParticipant()?.role;
    return role === 'HOST' || role === 'CO_HOST';
  });
  readonly pendingParticipants = computed(() => this.room()?.participants.filter((participant) => !participant.admitted) ?? []);
  private readonly socketDisposers: Array<() => void> = [];

  constructor(
    readonly store: RoomStore,
    readonly webrtc: WebRtcService,
    readonly router: Router,
    readonly route: ActivatedRoute,
    private readonly socket: SocketService,
    private readonly http: HttpClient
  ) {}

  ngOnInit(): void {
    this.bindSocketEvents();
    void this.webrtc.refreshDevices();
    const routeRoomId = this.route.snapshot.paramMap.get('roomId');
    const room = this.room();
    if (routeRoomId && (!room || room.id !== routeRoomId)) {
      void this.restoreRoomFromRoute(routeRoomId);
      return;
    }
    if (room) {
      void this.refreshOperationalState(room.id);
    }
  }

  ngOnDestroy(): void {
    for (const dispose of this.socketDisposers.splice(0)) {
      dispose();
    }
  }

  async publishCamera(): Promise<void> {
    const room = this.room();
    if (!room) {
      return;
    }
    this.publishing.set(true);
    this.error.set('');
    try {
      const stream = await this.webrtc.startCamera(this.audioDeviceId(), this.videoDeviceId());
      const transport = await this.webrtc.preparePeer(room.id);
      const audioProducer = await this.webrtc.publish(room.id, transport, 'audio', stream);
      const videoProducer = await this.webrtc.publish(room.id, transport, 'video', stream);
      this.applyProducerPolicyNotice(audioProducer);
      this.applyProducerPolicyNotice(videoProducer);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Unable to publish camera');
    } finally {
      this.publishing.set(false);
    }
  }

  toggleAudio(): void {
    this.webrtc.localStream()?.getAudioTracks().forEach((track) => (track.enabled = !track.enabled));
  }

  toggleVideo(): void {
    this.webrtc.localStream()?.getVideoTracks().forEach((track) => (track.enabled = !track.enabled));
  }

  async toggleScreen(): Promise<void> {
    const room = this.room();
    if (!room) {
      return;
    }
    if (this.webrtc.screenStream()) {
      this.webrtc.stopScreen();
      return;
    }
    const stream = await this.webrtc.startScreen();
    const transport = await this.webrtc.preparePeer(room.id);
    const producer = await this.webrtc.publish(room.id, transport, 'screen', stream);
    this.applyProducerPolicyNotice(producer);
  }

  async sendMessage(message: string): Promise<void> {
    const room = this.room();
    if (room) {
      await this.socket.emitAck('chat:send', { roomId: room.id, message });
    }
  }

  async mute(participantId: string): Promise<void> {
    const room = this.room();
    if (room) {
      await this.runOwnerRoomAction(room.id, () => this.socket.emitAck('participant:mute', { roomId: room.id, participantId, force: true }), 'Unable to mute participant');
    }
  }

  async kick(participantId: string): Promise<void> {
    const room = this.room();
    if (room) {
      await this.runOwnerRoomAction(
        room.id,
        () => this.socket.emitAck('participant:kick', { roomId: room.id, participantId, reason: 'Removed by host' }),
        'Unable to remove participant'
      );
    }
  }

  async admit(participantId: string): Promise<void> {
    const room = this.room();
    if (room) {
      await this.runOwnerRoomAction(room.id, () => this.socket.emitAck('room:admit', { roomId: room.id, participantId }), 'Unable to admit participant');
    }
  }

  async reject(participantId: string): Promise<void> {
    const room = this.room();
    if (room) {
      await this.runOwnerRoomAction(room.id, () => this.socket.emitAck('room:reject', { roomId: room.id, participantId }), 'Unable to reject participant');
    }
  }

  async lock(): Promise<void> {
    const room = this.room();
    if (room) {
      await this.runOwnerRoomAction(room.id, () => this.socket.emitAck('room:lock', { roomId: room.id }), 'Unable to lock room');
    }
  }

  async unlock(): Promise<void> {
    const room = this.room();
    if (room) {
      await this.runOwnerRoomAction(room.id, () => this.socket.emitAck('room:unlock', { roomId: room.id }), 'Unable to unlock room');
    }
  }

  async closeRoom(): Promise<void> {
    const room = this.room();
    if (room) {
      let closed = false;
      await this.runOwnerRoomAction(room.id, async () => {
        await this.socket.emitAck('room:close', { roomId: room.id });
        closed = true;
      }, 'Unable to close room');
      if (closed) {
        await this.router.navigate(['/']);
      }
    }
  }

  async leave(): Promise<void> {
    const room = this.room();
    if (room) {
      await this.socket.emitAck('room:leave', { roomId: room.id });
    }
    this.webrtc.stopCamera();
    this.webrtc.stopScreen();
    await this.router.navigate(['/']);
  }

  startRecording(): void {
    const room = this.room();
    if (!room) {
      return;
    }
    this.http.post<{ id: string }>(`${API_BASE_URL}/recordings/start`, { roomId: room.id, scope: 'room' }).subscribe((recording) => {
      this.currentRecordingId.set(recording.id);
      this.recording.set(true);
    });
  }

  stopRecording(): void {
    const id = this.currentRecordingId();
    if (!id) {
      return;
    }
    this.http.post(`${API_BASE_URL}/recordings/${id}/stop`, {}).subscribe(() => {
      this.recording.set(false);
      this.currentRecordingId.set(null);
    });
  }

  async updateRoomMediaProfile(profileId: RoomMediaProfileId): Promise<void> {
    const room = this.room();
    if (!room || room.mediaProfile.id === profileId || !this.canManageRoom()) {
      return;
    }
    this.profileUpdating.set(true);
    this.error.set('');
    try {
      const updatedRoom = await this.socket.emitAck('room:update-media-profile', { roomId: room.id, profileId });
      this.store.setRoom(updatedRoom);
      await this.refreshOperationalState(room.id);
    } catch (error) {
      if (this.followRoomOwnerRedirect(error, room.id)) {
        return;
      }
      this.error.set(error instanceof Error ? error.message : 'Unable to update room profile');
    } finally {
      this.profileUpdating.set(false);
    }
  }

  async runRecoveryAction(action: RoomRecoveryActionType, reason?: string): Promise<void> {
    const room = this.room();
    if (!room || !this.canManageRoom()) {
      return;
    }
    this.error.set('');
    try {
      const result = await this.socket.emitAck('room:run-recovery-action', { roomId: room.id, action, reason });
      this.store.setRoom(result.room);
      this.store.applyRoomIncidentState(result.incidentState);
      await this.refreshOperationalState(room.id);
    } catch (error) {
      if (this.followRoomOwnerRedirect(error, room.id)) {
        return;
      }
      this.error.set(error instanceof Error ? error.message : 'Unable to run room recovery action');
    }
  }

  private async refreshOperationalState(roomId: string): Promise<void> {
    const [quality, summary, incidentState, incidentTimeline, snapshotHistory] = await Promise.allSettled([
      this.socket.emitAck('room:get-quality', { roomId }),
      this.socket.emitAck('room:get-quality-summary', { roomId }),
      this.socket.emitAck('room:get-incident-state', { roomId }),
      this.socket.emitAck('room:get-incident-timeline', { roomId, limit: 24 }),
      this.socket.emitAck('room:get-snapshot-history', { roomId, limit: 12 })
    ]);
    if (quality.status === 'fulfilled') {
      this.store.applyRoomQuality(quality.value);
    }
    if (summary.status === 'fulfilled') {
      this.store.applyRoomQualitySummary(summary.value);
    }
    if (incidentState.status === 'fulfilled') {
      this.store.applyRoomIncidentState(incidentState.value);
    }
    if (incidentTimeline.status === 'fulfilled') {
      this.store.applyRoomIncidentTimeline(incidentTimeline.value);
    }
    if (snapshotHistory.status === 'fulfilled') {
      this.store.applyRoomSnapshotHistory(snapshotHistory.value);
    }
  }

  private async restoreRoomFromRoute(roomId: string): Promise<void> {
    const displayName = this.route.snapshot.queryParamMap.get('joinDisplayName')?.trim() || 'Participant';
    const asViewer = this.route.snapshot.queryParamMap.get('joinAsViewer') === '1';
    this.error.set('');
    try {
      const response = await this.socket.emitAck('room:join', { roomId, displayName, asViewer });
      this.store.setRoom(response.room);
      this.store.setLocalParticipant(response.participantId);
      if (this.route.snapshot.queryParamMap.has('joinDisplayName') || this.route.snapshot.queryParamMap.has('joinAsViewer')) {
        await this.router.navigate([], {
          relativeTo: this.route,
          replaceUrl: true,
          queryParamsHandling: 'merge',
          queryParams: {
            joinDisplayName: null,
            joinAsViewer: null
          }
        });
      }
      await this.refreshOperationalState(roomId);
    } catch (error) {
      if (this.followRoomOwnerRedirect(error, roomId, { displayName, asViewer })) {
        return;
      }
      this.error.set(error instanceof Error ? error.message : 'Unable to restore room session');
    }
  }

  private bindSocketEvents(): void {
    this.registerSocketHandler('room:updated', (room) => this.store.setRoom(room));
    this.registerSocketHandler('room:owner-changed', (owner) => this.store.applyRoomOwner(owner));
    this.registerSocketHandler('room:incident-updated', (state) => this.store.applyRoomIncidentState(state));
    this.registerSocketHandler('room:incident-event', (event) => this.store.appendRoomIncidentEvent(event));
    this.registerSocketHandler('room:snapshot-generated', (summary) => this.store.appendRoomSnapshotBundle(summary));
    this.registerSocketHandler('participant:joined', (participant) => this.store.upsertParticipant(participant));
    this.registerSocketHandler('participant:left', (participantId) => this.store.removeParticipant(participantId));
    this.registerSocketHandler('participant:updated', (participantId, patch) => this.store.patchParticipant(participantId, patch as Participant));
    this.registerSocketHandler('permissions:updated', (participantId, permissions) => this.store.patchParticipant(participantId, { permissions } as Participant));
    this.registerSocketHandler('producer:created', (producer) => this.store.upsertProducer(producer));
    this.registerSocketHandler('producer:updated', (producer) => this.store.upsertProducer(producer));
    this.registerSocketHandler('producer:closed', (producerId) => this.store.removeProducer(producerId));
    this.registerSocketHandler('producer:score-updated', (state) => this.store.applyProducerQuality(state));
    this.registerSocketHandler('producer:layers-needed', (event) => {
      this.store.applyProducerDynacast(event);
      void this.webrtc.applyProducerDynacast(event);
    });
    this.registerSocketHandler('producer:layers-unneeded', (event) => {
      this.store.applyProducerDynacast(event);
      void this.webrtc.applyProducerDynacast(event);
    });
    this.registerSocketHandler('producer:dynacast-updated', (event) => this.store.applyProducerDynacast(event));
    this.registerSocketHandler('consumer:created', (consumer) => this.store.upsertConsumer(consumer));
    this.registerSocketHandler('consumer:updated', (consumer) => this.store.upsertConsumer(consumer));
    this.registerSocketHandler('consumer:score-updated', (state) => {
      this.store.applyConsumerQuality(state);
      if (state.participantId === this.store.localParticipantId()) {
        this.webrtc.setNetworkQualityScore(state.score.score);
      }
    });
    this.registerSocketHandler('room:quality-updated', (state) => this.store.applyRoomQuality(state));
    this.registerSocketHandler('room:quality-summary-updated', (state) => this.store.applyRoomQualitySummary(state));
    this.registerSocketHandler('network:quality', (quality) => {
      if (quality.participantId === this.store.localParticipantId()) {
        this.webrtc.networkScore.set(quality.score);
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
    this.registerSocketHandler('chat:message', (message: ChatMessage) => this.store.addMessage(message));
    this.registerSocketHandler('room:failed', (event: RoomFailureEvent) => {
      const room = this.room();
      if (room?.id === event.roomId) {
        this.store.setRoom({
          ...room,
          mediaState: {
            status: 'failed',
            failedAt: event.failedAt,
            failureReason: event.reason,
            failureMessage: event.message,
            workerId: event.workerId
          }
        });
      }
      this.error.set(event.message);
    });
    this.registerSocketHandler('room:closed', () => void this.router.navigate(['/']));
    this.registerSocketHandler('participant:kicked', (reason) => {
      this.error.set(reason ?? 'You were removed from the room');
      void this.router.navigate(['/']);
    });
    this.registerSocketHandler('participant:banned', (reason) => {
      this.error.set(reason ?? 'You were banned from the room');
      void this.router.navigate(['/']);
    });
  }

  private registerSocketHandler<K extends keyof ServerToClientEvents>(
    event: K,
    handler: (...args: Parameters<ServerToClientEvents[K]>) => void
  ): void {
    this.socket.on(event, handler);
    this.socketDisposers.push(() => this.socket.off(event, handler));
  }

  private applyProducerPolicyNotice(producer: { policyDecision?: { action: string; message: string } }): void {
    if (producer.policyDecision && producer.policyDecision.action !== 'allow') {
      this.error.set(producer.policyDecision.message);
    }
  }

  private async runOwnerRoomAction(roomId: string, action: () => Promise<void>, fallbackMessage: string): Promise<void> {
    this.error.set('');
    try {
      await action();
    } catch (error) {
      if (this.followRoomOwnerRedirect(error, roomId)) {
        return;
      }
      this.error.set(error instanceof Error ? error.message : fallbackMessage);
    }
  }

  private followRoomOwnerRedirect(
    error: unknown,
    roomId: string,
    joinContext?: { displayName?: string; asViewer?: boolean }
  ): boolean {
    if (!(error instanceof SocketAckError) || error.code !== 'ROOM_REDIRECT') {
      return false;
    }
    const redirect = error.details as Partial<RoomOwnerRedirect> | undefined;
    if (!redirect?.ownerUrl || typeof window === 'undefined') {
      return false;
    }
    window.location.assign(buildRoomOwnerRedirectUrl(redirect.ownerUrl, roomId, joinContext));
    return true;
  }
}
