import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import type { WhiteboardMemorySnapshot } from '@native-sfu/contracts';
import { MediaStreamDirective } from '../../shared/media-stream/media-stream.directive';
import { Whiteboard } from '../../shared/whiteboard/whiteboard';
import { ClassSessionService } from '../class-session/class-session.service';
import { DesktopPlayback, DesktopRecording, DesktopService } from './desktop.service';

@Component({ selector: 'sfu-desktop-recordings', standalone: true, imports: [DatePipe, FormsModule, Whiteboard, MediaStreamDirective], changeDetection: ChangeDetectionStrategy.OnPush, styleUrl: './desktop.scss', template: `
  <section aria-labelledby="recordings-title">
    <div class="page-heading"><div><p class="eyebrow">LEARN AT YOUR PACE</p><h1 id="recordings-title">Recordings</h1><p class="muted">Revisit lessons and pick up where you left off.</p></div><button class="secondary" (click)="load()" [disabled]="loading()">Refresh</button></div>
    @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
    @if (selectedId()) {
      <section class="player-panel" aria-label="Recording player">
        <div class="section-heading"><h2>{{ selected()?.sessionTitle || selected()?.title || 'Class recording' }}</h2><button class="quiet" (click)="closePlayer()">Close player</button></div>
        @if (playbackLoading()) { <p role="status">Preparing your recording…</p> }
        @if (playerError()) { <p class="error" role="alert">{{ playerError() }}</p><button class="secondary" (click)="refreshTicket()">Reload recording</button> }
        @if (playback(); as media) {
          <video #player sfuAudioOutput crossorigin="anonymous" controls playsinline preload="metadata" [src]="media.playbackUrl" (loadedmetadata)="restorePosition($event)" (play)="saveProgress('play')" (pause)="saveProgress('pause')" (timeupdate)="heartbeat()" (seeked)="saveProgress('seek')" (ended)="saveProgress('ended')" (error)="mediaError()" aria-label="Class recording"></video>
          <div class="player-controls"><label>Playback speed<select aria-label="Playback speed" [ngModel]="speed" (ngModelChange)="changeSpeed($event)"><option [ngValue]="0.75">0.75×</option><option [ngValue]="1">1×</option><option [ngValue]="1.25">1.25×</option><option [ngValue]="1.5">1.5×</option><option [ngValue]="2">2×</option></select></label><span class="muted small" role="status">{{ progressNotice() || 'Your place is saved as you watch.' }}</span></div>
          @if (media.notesUrl) { <div class="lesson-notes"><button class="secondary" (click)="toggleNotes()" [disabled]="notesLoading()">{{ notes() ? 'Hide whiteboard notes' : notesLoading() ? 'Loading notes…' : 'View whiteboard notes' }}</button>@if (notes(); as board) { <div class="notes-board"><sfu-whiteboard title="Lesson notes" eyebrow="Published whiteboard" [initialState]="board" [readOnly]="true" [allowPageManagement]="false" [allowAssetImport]="false" [allowClear]="false" /></div> }</div> }
          @if (media.materials.length) { <div class="lesson-notes"><h3>Lesson notes and materials</h3>@for (material of media.materials; track material.materialId) { <button class="material-link" (click)="openMaterial(material)">{{ material.title }} <span aria-hidden="true">↗</span></button> }</div> }
        }
      </section>
    }
    <form class="recording-filters" (ngSubmit)="load()"><label class="search-label"><span class="sr-only">Search recordings</span><input name="query" type="search" placeholder="Search classes or teachers" [(ngModel)]="query" /></label><label><span class="sr-only">Course</span><select name="course" aria-label="Filter recordings by course" [(ngModel)]="courseId" (ngModelChange)="load()"><option value="">All courses</option>@for (course of courses(); track course.id) { <option [value]="course.id">{{ course.name }}</option> }</select></label><button class="secondary" type="submit">Search</button></form>
    @if (loading() && !items().length) { <p class="empty" role="status">Loading recordings…</p> }
    @else if (!items().length && !error()) { <div class="empty"><h2>{{ query || courseId ? 'No matching recordings' : 'No recordings yet' }}</h2><p>Recordings appear here after your teacher publishes them.</p></div> }
    <div class="recording-grid">@for (item of items(); track item.recordingId) {
      <article class="recording-card"><div class="recording-preview" aria-hidden="true">{{ item.status === 'available' ? '▶' : '◷' }}<span>{{ duration(item.durationSeconds) }}</span></div><div class="recording-body"><span class="status">{{ statusLabel(item) }}</span><h2>{{ item.sessionTitle || item.title }}</h2><p class="muted">{{ item.courseName || item.batchName }}</p><p class="muted small">{{ item.teacherName }} · {{ item.startedAt | date:'mediumDate' }}</p>
        @if (item.status === 'available') { <button class="primary" (click)="selectRecording(item)">{{ item.lastPositionSeconds > 0 ? 'Resume lesson' : 'Watch lesson' }}</button> }
        @else { <p class="muted small">{{ statusHelp(item) }}</p> }
      </div></article>
    }</div>
  </section>` })
export class DesktopRecordings implements OnDestroy {
  @ViewChild('player') private player?: ElementRef<HTMLVideoElement>;
  private readonly desktop = inject(DesktopService);
  private readonly sessions = inject(ClassSessionService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly items = signal<DesktopRecording[]>([]);
  protected readonly courses = signal<Array<{ id: string; name: string }>>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly playback = signal<DesktopPlayback | null>(null);
  protected readonly playbackLoading = signal(false);
  protected readonly playerError = signal('');
  protected readonly progressNotice = signal('');
  protected readonly selectedId = signal('');
  protected readonly notes = signal<WhiteboardMemorySnapshot | null>(null);
  protected readonly notesLoading = signal(false);
  private ticketTimer?: ReturnType<typeof setTimeout>;
  private resumeState?: { position: number; playing: boolean };
  private refreshingTicket = false;
  private automaticallyRetried = false;
  protected readonly selected = computed(() => this.items().find((item) => item.recordingId === this.selectedId()));
  protected query = '';
  protected courseId = '';
  protected speed = 1;
  private lastHeartbeat = 0;
  private listRequest?: Subscription;
  private playbackRequest?: Subscription;
  private routeSubscription: Subscription;
  private refreshTimer = setInterval(() => this.load(true), 60_000);
  constructor() {
    this.load();
    this.routeSubscription = this.route.queryParamMap.subscribe((params) => {
      const id = params.get('recordingId') ?? '';
      if (id !== this.selectedId()) { this.saveProgress('pause'); this.selectedId.set(id); this.playback.set(null); this.notes.set(null); this.resumeState = undefined; this.refreshingTicket = false; this.automaticallyRetried = false; clearTimeout(this.ticketTimer); if (id) this.openPlayer(id); }
    });
  }
  protected load(background = false): void {
    if (this.loading()) return;
    this.loading.set(true); if (!background) this.error.set('');
    this.listRequest = this.desktop.recordings(this.query.trim(), this.courseId).subscribe({
      next: (response) => {
        this.items.set(response.items); this.loading.set(false); this.error.set('');
        const courses = new Map(this.courses().map((course) => [course.id, course.name]));
        response.items.forEach((item) => { if (item.courseId) courses.set(item.courseId, item.courseName || item.batchName); });
        this.courses.set([...courses].map(([id, name]) => ({ id, name })));
      }, error: (error) => { this.loading.set(false); this.error.set(this.sessions.errorMessage(error)); }
    });
  }
  protected selectRecording(item: DesktopRecording): void { void this.router.navigate([], { relativeTo: this.route, queryParams: { recordingId: item.recordingId } }); }
  protected closePlayer(): void { this.saveProgress('pause'); this.player?.nativeElement.pause(); void this.router.navigate([], { relativeTo: this.route, queryParams: {} }); }
  protected openPlayer(id: string): void {
    this.playbackRequest?.unsubscribe(); this.refreshingTicket = false; clearTimeout(this.ticketTimer); this.playbackLoading.set(true); this.playerError.set(''); this.progressNotice.set(''); this.playback.set(null);
    this.playbackRequest = this.desktop.playback(id).subscribe({
      next: (media) => { this.playback.set(media); this.playbackLoading.set(false); this.scheduleTicket(media.expiresAt); },
      error: (error) => { this.playbackLoading.set(false); this.playerError.set(this.sessions.errorMessage(error)); }
    });
  }
  protected restorePosition(event: Event): void {
    const media = event.target as HTMLVideoElement;
    // A loaded replacement establishes a fresh retry budget. A ticket response alone
    // does not: broken media must not create an endless refresh/error loop.
    this.automaticallyRetried = false;
    this.playerError.set('');
    const resumed = this.resumeState;
    const position = resumed?.position ?? this.playback()?.lastPositionSeconds ?? 0;
    if (Number.isFinite(media.duration) && position > 0 && position < media.duration - 2) media.currentTime = position;
    media.playbackRate = this.speed;
    this.resumeState = undefined;
    if (resumed?.playing) void media.play().catch(() => this.progressNotice.set('Your recording is ready. Press play to continue.'));
  }
  protected changeSpeed(value: number): void { this.speed = Number(value); if (this.player) this.player.nativeElement.playbackRate = this.speed; }
  protected heartbeat(): void { if (Date.now() - this.lastHeartbeat > 10_000) { this.lastHeartbeat = Date.now(); this.saveProgress('timeupdate'); } }
  protected saveProgress(event: string): void {
    const media = this.player?.nativeElement;
    const id = this.playback()?.recordingId;
    if (!media || !id || !Number.isFinite(media.currentTime) || media.readyState === 0) return;
    const position = media.currentTime;
    this.desktop.progress(id, position, media.duration, event).subscribe({
      next: () => { this.progressNotice.set(''); this.items.update((items) => items.map((item) => item.recordingId === id ? { ...item, lastPositionSeconds: position } : item)); },
      error: () => this.progressNotice.set('Your place could not be saved. We will retry while you watch.')
    });
  }
  protected mediaError(): void {
    if (!this.automaticallyRetried && !this.refreshingTicket) { this.automaticallyRetried = true; this.refreshTicket(); return; }
    this.playerError.set('The recording could not be played. Reload it to refresh access, or try again when your connection returns.');
  }
  private scheduleTicket(expiresAt: string): void {
    clearTimeout(this.ticketTimer);
    const delay = Date.parse(expiresAt) - Date.now() - 60_000;
    if (Number.isFinite(delay)) this.ticketTimer = setTimeout(() => this.refreshTicket(), Math.max(10_000, delay));
  }
  protected refreshTicket(): void {
    const id = this.selectedId();
    if (!id || this.refreshingTicket) return;
    this.refreshingTicket = true;
    this.playbackRequest?.unsubscribe();
    this.playbackRequest = this.desktop.playback(id).subscribe({
      next: (media) => {
        const player = this.player?.nativeElement;
        this.resumeState = { position: player?.currentTime ?? this.playback()?.lastPositionSeconds ?? 0, playing: Boolean(player && !player.paused && !player.ended) };
        this.playback.set(media); this.playerError.set(''); this.refreshingTicket = false;
        this.scheduleTicket(media.expiresAt);
      },
      error: (error) => { this.refreshingTicket = false; this.playerError.set(this.sessions.errorMessage(error)); this.ticketTimer = setTimeout(() => this.refreshTicket(), 60_000); }
    });
  }
  protected toggleNotes(): void {
    if (this.notes()) { this.notes.set(null); return; }
    this.notesLoading.set(true);
    this.desktop.notes(this.selectedId()).subscribe({ next: (response) => { this.notes.set(response.snapshot); this.notesLoading.set(false); }, error: (error) => { this.playerError.set(this.sessions.errorMessage(error)); this.notesLoading.set(false); } });
  }
  protected openMaterial(material: DesktopPlayback['materials'][number]): void {
    const item = this.selected();
    if (material.url) {
      try { const url = new URL(material.url); if (url.protocol === 'https:' || url.protocol === 'http:') { if (this.desktop.bridge) void this.desktop.bridge.openExternal(url.href).catch(() => this.playerError.set('This material link could not be opened.')); else window.open(url.href, '_blank', 'noopener,noreferrer'); } } catch { this.playerError.set('This material link is invalid.'); }
      return;
    }
    if (!item) { this.playerError.set('Refresh the recordings list to open these notes.'); return; }
    this.sessions.downloadMaterial(item.sessionId, material.materialId, { batchId: item.batchId }).subscribe({
      next: (blob) => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = material.title; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000); },
      error: (error) => this.playerError.set(this.sessions.errorMessage(error))
    });
  }
  protected duration(seconds: number): string { if (!seconds) return ''; const minutes = Math.floor(seconds / 60); return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`; }
  protected statusLabel(item: DesktopRecording): string { return ({ available: 'Available', processing: 'Processing', failed: 'Recording failed', unavailable: 'Unavailable', expired: 'Expired' })[item.status]; }
  protected statusHelp(item: DesktopRecording): string { return item.status === 'processing' ? 'Your lesson is being prepared. This list refreshes automatically.' : item.status === 'expired' ? 'The retention period for this recording has ended.' : 'Contact your teacher for the lesson materials.'; }
  ngOnDestroy(): void { this.saveProgress('pause'); this.player?.nativeElement.pause(); this.listRequest?.unsubscribe(); this.playbackRequest?.unsubscribe(); this.routeSubscription.unsubscribe(); clearInterval(this.refreshTimer); clearTimeout(this.ticketTimer); }
}
