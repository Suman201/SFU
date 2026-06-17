import { Component, computed, OnInit, signal, ChangeDetectionStrategy } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import type { ChatMessage, Participant, Producer, Role } from '@native-sfu/contracts';
import { API_BASE_URL } from '../../core/services/app-environment';
import { RoomStore } from '../../core/services/room.store';
import { SocketService } from '../../core/services/socket.service';
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
            <sfu-host-controls [isHost]="isHost()" (lock)="lock()" (unlock)="unlock()" (close)="closeRoom()" />
            <sfu-recording-controls [isHost]="isHost()" [recording]="recording()" (start)="startRecording()" (stop)="stopRecording()" />
            <sfu-waiting-room [pending]="pendingParticipants()" (admit)="admit($event)" (reject)="reject($event)" />
          </div>
        </section>

        @if (error()) {
          <p class="error">{{ error() }}</p>
        }
      </main>
    } @else {
      <main class="empty">
        <h1>No active room</h1>
        <button class="primary" type="button" (click)="router.navigate(['/'])">Open lobby</button>
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
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--panel-muted);
        padding: 12px;
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
export class RoomComponent implements OnInit {
  readonly room = this.store.room;
  readonly publishing = signal(false);
  readonly error = signal('');
  readonly recording = signal(false);
  readonly currentRecordingId = signal<string | null>(null);
  readonly audioDeviceId = signal('');
  readonly videoDeviceId = signal('');

  readonly localParticipant = computed(() => this.room()?.participants.find((participant) => participant.id === this.store.localParticipantId()) ?? null);
  readonly isHost = computed(() => this.localParticipant()?.role === 'HOST');
  readonly pendingParticipants = computed(() => this.room()?.participants.filter((participant) => !participant.admitted) ?? []);

  constructor(
    readonly store: RoomStore,
    readonly webrtc: WebRtcService,
    readonly router: Router,
    private readonly socket: SocketService,
    private readonly http: HttpClient
  ) {}

  ngOnInit(): void {
    this.bindSocketEvents();
    void this.webrtc.refreshDevices();
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
      await this.webrtc.publish(room.id, transport, 'audio', stream);
      await this.webrtc.publish(room.id, transport, 'video', stream);
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
    await this.webrtc.publish(room.id, transport, 'screen', stream);
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
      await this.socket.emitAck('participant:mute', { roomId: room.id, participantId, force: true });
    }
  }

  async kick(participantId: string): Promise<void> {
    const room = this.room();
    if (room) {
      await this.socket.emitAck('participant:kick', { roomId: room.id, participantId, reason: 'Removed by host' });
    }
  }

  async admit(participantId: string): Promise<void> {
    const room = this.room();
    if (room) {
      await this.socket.emitAck('room:admit', { roomId: room.id, participantId });
    }
  }

  async reject(participantId: string): Promise<void> {
    const room = this.room();
    if (room) {
      await this.socket.emitAck('room:reject', { roomId: room.id, participantId });
    }
  }

  async lock(): Promise<void> {
    const room = this.room();
    if (room) {
      await this.socket.emitAck('room:lock', { roomId: room.id });
    }
  }

  async unlock(): Promise<void> {
    const room = this.room();
    if (room) {
      await this.socket.emitAck('room:unlock', { roomId: room.id });
    }
  }

  async closeRoom(): Promise<void> {
    const room = this.room();
    if (room) {
      await this.socket.emitAck('room:close', { roomId: room.id });
      await this.router.navigate(['/']);
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

  private bindSocketEvents(): void {
    this.socket.on('room:updated', (room) => this.store.setRoom(room));
    this.socket.on('participant:joined', (participant) => this.store.upsertParticipant(participant));
    this.socket.on('participant:left', (participantId) => this.store.removeParticipant(participantId));
    this.socket.on('participant:updated', (participantId, patch) => this.store.patchParticipant(participantId, patch as Participant));
    this.socket.on('permissions:updated', (participantId, permissions) => this.store.patchParticipant(participantId, { permissions } as Participant));
    this.socket.on('producer:created', (producer) => this.store.upsertProducer(producer));
    this.socket.on('producer:updated', (producer) => this.store.upsertProducer(producer));
    this.socket.on('producer:closed', (producerId) => this.store.removeProducer(producerId));
    this.socket.on('producer:score-updated', (state) => this.store.applyProducerQuality(state));
    this.socket.on('producer:layers-needed', (event) => {
      this.store.applyProducerDynacast(event);
      void this.webrtc.applyProducerDynacast(event);
    });
    this.socket.on('producer:layers-unneeded', (event) => {
      this.store.applyProducerDynacast(event);
      void this.webrtc.applyProducerDynacast(event);
    });
    this.socket.on('producer:dynacast-updated', (event) => this.store.applyProducerDynacast(event));
    this.socket.on('consumer:created', (consumer) => this.store.upsertConsumer(consumer));
    this.socket.on('consumer:updated', (consumer) => this.store.upsertConsumer(consumer));
    this.socket.on('consumer:score-updated', (state) => {
      this.store.applyConsumerQuality(state);
      if (state.participantId === this.store.localParticipantId()) {
        this.webrtc.setNetworkQualityScore(state.score.score);
      }
    });
    this.socket.on('room:quality-updated', (state) => this.store.applyRoomQuality(state));
    this.socket.on('network:quality', (quality) => {
      if (quality.participantId === this.store.localParticipantId()) {
        this.webrtc.networkScore.set(quality.score);
      }
    });
    this.socket.on('consumer:layers-changed', (event) => this.store.applyConsumerLayerEvent(event));
    this.socket.on('consumer:layers-switching', (event) => this.store.applyConsumerLayerEvent(event));
    this.socket.on('consumer:layers-unavailable', (event) => this.store.applyConsumerLayerEvent(event));
    this.socket.on('consumer:layers-switch-failed', (event) => this.store.applyConsumerLayerEvent(event));
    this.socket.on('consumer:svc-layers-changed', (event) => this.store.applyConsumerLayerEvent(event));
    this.socket.on('consumer:svc-layers-switching', (event) => this.store.applyConsumerLayerEvent(event));
    this.socket.on('consumer:svc-layers-unavailable', (event) => this.store.applyConsumerLayerEvent(event));
    this.socket.on('consumer:svc-layers-switch-failed', (event) => this.store.applyConsumerLayerEvent(event));
    this.socket.on('chat:message', (message: ChatMessage) => this.store.addMessage(message));
    this.socket.on('room:closed', () => void this.router.navigate(['/']));
    this.socket.on('participant:kicked', (reason) => {
      this.error.set(reason ?? 'You were removed from the room');
      void this.router.navigate(['/']);
    });
    this.socket.on('participant:banned', (reason) => {
      this.error.set(reason ?? 'You were banned from the room');
      void this.router.navigate(['/']);
    });
  }
}
