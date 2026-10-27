import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { WebRtcService } from '../../core/services/webrtc.service';
import { DeviceSetupComponent } from './device-setup';
import { DeviceSetupDialogComponent } from './device-setup-dialog';

describe('Shared device setup', () => {
  let fixture: ComponentFixture<DeviceSetupComponent>;
  let component: DeviceSetupComponent;
  let media: any;
  let getUserMedia: jasmine.Spy;
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve));
  const camera = () => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 32; canvas.getContext('2d')!.fillRect(0, 0, 32, 32); return canvas.captureStream(10); };
  beforeEach(() => {
    media = {
      devices: signal({ audioInputs: [{ id: 'mic-a', label: 'Microphone A' }], videoInputs: [{ id: 'camera-a', label: 'Webcam A' }], audioOutputs: [{ id: 'speaker-a', label: 'Speakers A' }] }),
      selectedAudioDeviceId: signal('mic-a'), selectedVideoDeviceId: signal('camera-a'), selectedSpeakerDeviceId: signal('speaker-a'), speakerError: signal(''),
      refreshDevices: jasmine.createSpy().and.resolveTo(), selectAudioDevice: jasmine.createSpy(), selectVideoDevice: jasmine.createSpy(), selectSpeakerDevice: jasmine.createSpy().and.resolveTo(), stopCamera: jasmine.createSpy()
    };
    getUserMedia = spyOn(navigator.mediaDevices, 'getUserMedia').and.rejectWith(new DOMException('Unavailable', 'NotFoundError'));
    TestBed.configureTestingModule({ imports: [DeviceSetupComponent, DeviceSetupDialogComponent], providers: [{ provide: WebRtcService, useValue: media }] });
    fixture = TestBed.createComponent(DeviceSetupComponent); component = fixture.componentInstance;
  });
  afterEach(() => fixture.destroy());

  it('automatically mounts the connected webcam stream in a private autoplay preview', async () => {
    const stream = camera(); getUserMedia.and.resolveTo(stream);
    fixture.detectChanges(); await settle(); fixture.detectChanges(); await settle();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    expect(getUserMedia).toHaveBeenCalledWith({ video: { deviceId: { exact: 'camera-a' } }, audio: false });
    expect(video).not.toBeNull(); expect(video.srcObject).toBe(stream); expect(video.autoplay).toBeTrue(); expect(video.muted).toBeTrue();
    fixture.destroy(); expect(stream.getVideoTracks()[0]!.readyState).toBe('ended');
    expect(media.stopCamera).not.toHaveBeenCalled();
  });

  it('reuses the classroom camera source without a competing capture and leaves live tracks running on close', async () => {
    const classroom = camera(); const liveTrack = classroom.getVideoTracks()[0]!; liveTrack.enabled = false;
    fixture.componentRef.setInput('live', true); fixture.componentRef.setInput('previewStream', classroom);
    fixture.detectChanges(); await settle(); fixture.detectChanges();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    const preview = video.srcObject as MediaStream;
    expect(getUserMedia).not.toHaveBeenCalled(); expect(preview).not.toBe(classroom);
    expect(preview.getVideoTracks()[0]!.enabled).toBeTrue(); expect(liveTrack.enabled).toBeFalse();
    fixture.destroy(); expect(preview.getVideoTracks()[0]!.readyState).toBe('ended'); expect(liveTrack.readyState).toBe('live');
    liveTrack.stop();
  });

  it('opens an accessible native classroom dialog and restores focus after closing', async () => {
    const dialogFixture = TestBed.createComponent(DeviceSetupDialogComponent); dialogFixture.detectChanges();
    const trigger = dialogFixture.nativeElement.querySelector('[aria-label="Device setup"]') as HTMLButtonElement;
    trigger.click(); dialogFixture.detectChanges(); await settle(); dialogFixture.detectChanges();
    const dialog = dialogFixture.nativeElement.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.open).toBeTrue(); expect(dialog.querySelector('sfu-device-setup')).not.toBeNull();
    (dialog.querySelector('[aria-label="Close device setup"]') as HTMLButtonElement).click(); dialogFixture.detectChanges();
    expect(dialog.open).toBeFalse(); expect(dialog.querySelector('sfu-device-setup')).toBeNull();
    expect(document.activeElement).toBe(trigger); dialogFixture.destroy();
  });

  it('shows actionable permission feedback instead of leaving a blank webcam preview', async () => {
    getUserMedia.and.rejectWith(new DOMException('Denied', 'NotAllowedError'));
    fixture.detectChanges(); await settle(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Allow camera access in system privacy settings');
    expect(fixture.nativeElement.querySelector('video')).toBeNull();
  });

  it('releases a preview permission request that resolves after the settings dialog closes', async () => {
    let resolve!: (stream: MediaStream) => void;
    getUserMedia.and.returnValue(new Promise<MediaStream>((done) => resolve = done));
    const pending = (component as any).openCameraPreview();
    fixture.destroy();
    const stream = camera(); resolve(stream); await pending;
    expect(stream.getTracks().every((track) => track.readyState === 'ended')).toBeTrue();
    expect(media.stopCamera).not.toHaveBeenCalled();
  });

  it('delegates live input switching to the classroom without prematurely changing its selected device', () => {
    fixture.componentRef.setInput('live', true);
    const microphone = jasmine.createSpy(); const webcam = jasmine.createSpy();
    component.microphoneSelected.subscribe(microphone); component.cameraSelected.subscribe(webcam);
    (component as any).previewWanted = false;
    (component as any).selectMicrophone('mic-b'); (component as any).selectCamera('camera-b');
    expect(microphone).toHaveBeenCalledOnceWith('mic-b'); expect(webcam).toHaveBeenCalledOnceWith('camera-b');
    expect(media.selectAudioDevice).not.toHaveBeenCalled(); expect(media.selectVideoDevice).not.toHaveBeenCalled();
  });

  it('plays the speaker test through the selected output and releases it on close', async () => {
    const audio = { setSinkId: jasmine.createSpy().and.resolveTo(), play: jasmine.createSpy().and.resolveTo(), pause: jasmine.createSpy(), src: '', volume: 1, onended: null, onerror: null };
    spyOn(window, 'Audio').and.returnValue(audio as unknown as HTMLAudioElement);
    await (component as any).testSpeaker();
    expect(audio.setSinkId).toHaveBeenCalledOnceWith('speaker-a'); expect(audio.play).toHaveBeenCalledOnceWith();
    fixture.destroy(); expect(audio.pause).toHaveBeenCalled(); expect(audio.src).toBe('');
  });

  it('reports output selection failure instead of claiming that the new preference was saved', async () => {
    media.speakerError.set('The selected speaker disconnected.'); media.selectSpeakerDevice.and.rejectWith(new Error('Not found'));
    await (component as any).selectSpeaker('missing-output');
    expect((component as any).deviceError()).toContain('disconnected');
    expect((component as any).deviceNotice()).not.toContain('saved');
  });
});
