import { ErrorCenter } from '@sapiovian/error-ui';
import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WebRtcService } from '../../core/services/webrtc.service';
import { MediaStreamDirective } from '../media-stream/media-stream.directive';

/** Shared settings page and in-class dialog. Preview tracks are owned here, never the live classroom tracks. */
@Component({
  selector: 'sfu-device-setup', standalone: true, imports: [FormsModule, MediaStreamDirective],
  changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './device-setup.html', styleUrl: './device-setup.scss'
})
export class DeviceSetupComponent implements OnInit, OnDestroy {
  @ViewChild('previewVideo') private previewVideo?: ElementRef<HTMLVideoElement>;
  readonly live = input(false);
  readonly previewStream = input<MediaStream | null>(null);
  private readonly borrowedPreview = signal<MediaStream | null>(null);
  protected readonly previewVisible = signal(true);
  protected readonly displayedCamera = computed(() => this.previewVisible() ? this.borrowedPreview() ?? this.cameraStream() : null);
  readonly microphoneSelected = output<string>();
  readonly cameraSelected = output<string>();
  private readonly errors = inject(ErrorCenter);
  protected readonly webrtc = inject(WebRtcService);
  protected readonly microphoneStream = signal<MediaStream | null>(null);
  protected readonly cameraStream = signal<MediaStream | null>(null);
  protected readonly microphoneLevel = signal(0);
  protected readonly deviceBusy = signal(false);
  protected readonly speakerBusy = signal(false);
  protected readonly deviceNotice = signal('');
  protected readonly deviceError = signal('');
  protected readonly previewBlocked = signal(false);
  private previewWanted = true;
  private cameraRequestId = 0;
  private readonly deviceChanged = () => { void this.refreshDevices().then(() => { if (this.previewWanted && !this.displayedCamera() && !this.deviceBusy() && this.webrtc.devices().videoInputs.length) void this.openCameraPreview(); }); };
  private audioContext?: AudioContext;
  private microphoneTimer?: ReturnType<typeof setInterval>;
  private testAudio?: HTMLAudioElement;
  private toneUrl?: string;
  private destroyed = false;

  constructor() {
    effect(() => {
      const stream = this.previewStream();
      const track = stream?.getVideoTracks().find((candidate) => candidate.readyState === 'live');
      untracked(() => {
        this.borrowedPreview()?.getTracks().forEach((candidate) => candidate.stop());
        this.borrowedPreview.set(null);
        if (track) {
          this.stopCamera();
          const privateTrack = track.clone();
          privateTrack.enabled = true;
          this.borrowedPreview.set(new MediaStream([privateTrack]));
        }
      });
    });
  }
  ngOnInit(): void { navigator.mediaDevices?.addEventListener('devicechange', this.deviceChanged); void this.refreshDevices().then(() => this.openCameraPreview()); }
  protected async refreshDevices(): Promise<void> {
    try { await this.webrtc.refreshDevices(); }
    catch { this.deviceError.set('Device access is unavailable. Check your system privacy settings and reconnect your devices.'); }
  }
  protected selectMicrophone(value: string): void {
    this.stopMicrophone();
    if (this.live()) this.microphoneSelected.emit(value);
    else this.webrtc.selectAudioDevice(value);
    this.deviceNotice.set(this.live() ? '' : 'Microphone preference saved.');
  }
  protected selectCamera(value: string): void {
    this.stopCamera();
    if (this.live()) this.cameraSelected.emit(value);
    else this.webrtc.selectVideoDevice(value);
    this.deviceNotice.set(this.live() ? '' : 'Camera preference saved.');
    if (this.previewWanted && !this.live()) void this.openCameraPreview(value);
  }
  protected async selectSpeaker(value: string): Promise<void> {
    this.stopSpeaker(); this.deviceError.set('');
    try { await this.webrtc.selectSpeakerDevice(value); this.deviceNotice.set('Speaker preference saved. Use Test speakers to check the selected output.'); }
    catch { this.deviceError.set(this.webrtc.speakerError() || 'The selected speaker could not be used. Choose another output or System default.'); }
  }
  protected async testMicrophone(): Promise<void> {
    if (this.microphoneStream()) { this.stopMicrophone(); return; }
    this.deviceBusy.set(true); this.deviceError.set('');
    try {
      const device = this.webrtc.selectedAudioDeviceId();
      const existing = this.previewStream()?.getAudioTracks().find((track) => track.readyState === 'live');
      const stream = existing ? new MediaStream([existing.clone()]) : await navigator.mediaDevices.getUserMedia({ audio: device ? { deviceId: { exact: device } } : true, video: false });
      stream.getAudioTracks().forEach((track) => track.enabled = true);
      if (this.destroyed) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.microphoneStream.set(stream);
      this.audioContext = new AudioContext();
      const analyser = this.audioContext.createAnalyser(); analyser.fftSize = 256;
      this.audioContext.createMediaStreamSource(stream).connect(analyser);
      await this.audioContext.resume();
      const samples = new Uint8Array(analyser.fftSize);
      this.microphoneTimer = setInterval(() => {
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
        this.microphoneLevel.set(Math.min(100, Math.round(rms * 500)));
      }, 100);
      this.deviceNotice.set('Speak normally. The microphone meter should move.');
      await this.refreshDevices();
    } catch (error) { this.stopMicrophone(); this.deviceError.set(this.permissionMessage(error, 'microphone')); }
    finally { this.deviceBusy.set(false); }
  }
  protected async testCamera(): Promise<void> {
    if (this.displayedCamera()) { this.previewWanted = false; this.previewVisible.set(false); this.stopCamera(); return; }
    this.previewWanted = true; this.previewVisible.set(true);
    await this.openCameraPreview();
  }
  private async openCameraPreview(selectedDevice?: string): Promise<void> {
    if (this.destroyed || !this.previewWanted || this.borrowedPreview()) return;
    const requestId = ++this.cameraRequestId;
    this.deviceBusy.set(true); this.deviceError.set(''); this.previewBlocked.set(false);
    try {
      const device = selectedDevice ?? this.webrtc.selectedVideoDeviceId();
      const stream = await navigator.mediaDevices.getUserMedia({ video: device ? { deviceId: { exact: device } } : true, audio: false });
      if (this.destroyed || requestId !== this.cameraRequestId) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.cameraStream.set(stream);
      stream.getVideoTracks().forEach((track) => track.addEventListener('ended', () => {
        if (this.cameraStream() === stream && !this.destroyed) { this.stopCamera(); this.deviceError.set('The webcam disconnected or stopped. Reconnect it or choose another camera.'); }
      }, { once: true }));
      await this.refreshDevices();
    } catch (error) { if (requestId === this.cameraRequestId) this.deviceError.set(this.permissionMessage(error, 'camera')); }
    finally { if (requestId === this.cameraRequestId) this.deviceBusy.set(false); }
  }
  protected onPreviewBlocked(): void { this.previewBlocked.set(true); this.deviceError.set('The webcam is connected, but preview playback was blocked. Select Resume preview.'); }
  protected async resumePreview(): Promise<void> {
    try { await this.previewVideo?.nativeElement.play(); this.previewBlocked.set(false); this.deviceError.set(''); }
    catch { this.onPreviewBlocked(); }
  }
  protected async testSpeaker(): Promise<void> {
    this.stopSpeaker(); this.speakerBusy.set(true); this.deviceError.set('');
    try {
      const audio = new Audio();
      this.testAudio = audio;
      const selected = this.webrtc.selectedSpeakerDeviceId() || '';
      if (typeof audio.setSinkId === 'function') await audio.setSinkId(selected);
      else if (selected) throw new Error('Speaker selection is unavailable. Choose System default and select your output in system settings.');
      if (this.destroyed || this.testAudio !== audio) return;
      this.toneUrl = URL.createObjectURL(speakerTone());
      audio.src = this.toneUrl; audio.volume = 0.35;
      audio.onended = () => this.stopSpeaker();
      audio.onerror = () => { this.deviceError.set('The selected speakers could not play the test. Check your system sound settings.'); this.stopSpeaker(); };
      await audio.play();
      this.deviceNotice.set('A short tone is playing through your selected speakers. If you cannot hear it, check the output device and volume.');
    } catch (error) { this.stopSpeaker(); this.deviceError.set(error instanceof Error ? error.message : 'Unable to play the speaker test.'); }
  }
  private permissionMessage(error: unknown, device: string): string {
    const name = error instanceof DOMException ? error.name : '';
    this.errors.capture(error, { quiet: true, code: name === 'NotAllowedError' || name === 'SecurityError' ? 'DEVICE_PERMISSION_DENIED' : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'DEVICE_NOT_FOUND' : 'DEVICE_BUSY' });
    if (name === 'NotAllowedError') return `Allow ${device} access in system privacy settings, then try again.`;
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return `The selected ${device} is unavailable. Connect it or choose System default.`;
    return `The ${device} could not start. Close other apps using it and try again.`;
  }
  private stopMicrophone(): void {
    this.microphoneStream()?.getTracks().forEach((track) => track.stop()); this.microphoneStream.set(null); this.microphoneLevel.set(0); clearInterval(this.microphoneTimer);
    if (this.audioContext && this.audioContext.state !== 'closed') void this.audioContext.close().catch(() => undefined);
    this.audioContext = undefined;
  }
  private stopCamera(): void { this.cameraRequestId++; this.deviceBusy.set(false); this.cameraStream()?.getTracks().forEach((track) => track.stop()); this.cameraStream.set(null); }
  private stopSpeaker(): void {
    if (this.testAudio) { this.testAudio.onended = null; this.testAudio.onerror = null; this.testAudio.pause(); this.testAudio.src = ''; }
    this.testAudio = undefined;
    if (this.toneUrl) URL.revokeObjectURL(this.toneUrl);
    this.toneUrl = undefined; this.speakerBusy.set(false);
  }
  ngOnDestroy(): void { this.destroyed = true; navigator.mediaDevices?.removeEventListener('devicechange', this.deviceChanged); this.stopCamera(); this.borrowedPreview()?.getTracks().forEach((track) => track.stop()); this.borrowedPreview.set(null); this.stopMicrophone(); this.stopSpeaker(); }
}

function speakerTone(): Blob {
  const sampleRate = 44100; const count = Math.floor(sampleRate * 0.6);
  const buffer = new ArrayBuffer(44 + count * 2); const view = new DataView(buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const fade = Math.min(1, i / (sampleRate * 0.02), (count - i) / (sampleRate * 0.05));
    view.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 16000 * fade), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
