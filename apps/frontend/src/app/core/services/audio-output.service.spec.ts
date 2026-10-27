import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AudioOutputService } from './audio-output.service';
import { MediaStreamDirective } from '../../shared/media-stream/media-stream.directive';

@Component({ standalone: true, imports: [MediaStreamDirective], template: '<video sfuAudioOutput src="/recording.webm"></video>' })
class RecordingPlayerFixture {}

describe('Shared classroom speaker selection', () => {
  const key = 'native-sfu.preferred-speaker-device';
  let previous: string | null;
  beforeEach(() => { previous = localStorage.getItem(key); localStorage.removeItem(key); });
  afterEach(() => { if (previous === null) localStorage.removeItem(key); else localStorage.setItem(key, previous); });
  const player = () => ({ setSinkId: jasmine.createSpy('setSinkId').and.resolveTo() }) as unknown as HTMLMediaElement;
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

  it('routes all live media and later recording players to the saved speaker', async () => {
    const service = new AudioOutputService();
    const first = player(); const second = player(); const later = player();
    service.register(first); service.register(second);
    await service.select('headphones');
    expect(first.setSinkId).toHaveBeenCalledWith('headphones');
    expect(second.setSinkId).toHaveBeenCalledWith('headphones');
    expect(localStorage.getItem(key)).toBe('headphones');
    service.register(later); await settle();
    expect(later.setSinkId).toHaveBeenCalledOnceWith('headphones');
  });

  it('rolls all players back and retains the previous choice when an output is unavailable', async () => {
    const service = new AudioOutputService(); const first = player(); const second = player();
    service.register(first); service.register(second); await service.select('working');
    (second.setSinkId as jasmine.Spy).and.callFake((id: string) => id === 'missing' ? Promise.reject(new Error('Disconnected')) : Promise.resolve());
    await expectAsync(service.select('missing')).toBeRejected();
    expect(service.selectedDevice()).toBe('working'); expect(localStorage.getItem(key)).toBe('working');
    expect((first.setSinkId as jasmine.Spy).calls.mostRecent().args).toEqual(['working']);
    expect(service.error()).toContain('could not be selected');
    await service.select('');
    expect(service.selectedDevice()).toBeNull(); expect(service.error()).toBe(''); expect(localStorage.getItem(key)).toBeNull();
  });

  it('does not route detached media elements during later speaker changes', async () => {
    const service = new AudioOutputService(); const first = player(); const second = player();
    const unregister = service.register(first); service.register(second); await service.select('speaker-a');
    unregister(); (first.setSinkId as jasmine.Spy).calls.reset();
    await service.select('speaker-b');
    expect(first.setSinkId).not.toHaveBeenCalled(); expect(second.setSinkId).toHaveBeenCalledWith('speaker-b');
  });

  it('serializes initial routing and output changes so delayed setup cannot restore an old device', async () => {
    localStorage.setItem(key, 'old');
    const service = new AudioOutputService(); const audio = player();
    let release!: () => void;
    (audio.setSinkId as jasmine.Spy).and.callFake((id: string) => id === 'old' ? new Promise<void>((resolve) => release = resolve) : Promise.resolve());
    service.register(audio); await settle();
    const selected = service.select('new'); await settle();
    expect(audio.setSinkId).not.toHaveBeenCalledWith('new');
    release(); await selected;
    expect((audio.setSinkId as jasmine.Spy).calls.mostRecent().args).toEqual(['new']);
    expect(service.selectedDevice()).toBe('new');
  });

  it('attaches output routing to the recorded-class player without replacing its source', () => {
    const audioOutput = { register: jasmine.createSpy('register').and.returnValue(jasmine.createSpy('unregister')) };
    TestBed.configureTestingModule({ imports: [RecordingPlayerFixture], providers: [{ provide: AudioOutputService, useValue: audioOutput }] });
    const fixture = TestBed.createComponent(RecordingPlayerFixture); fixture.detectChanges();
    const video = fixture.nativeElement.querySelector('video') as HTMLVideoElement;
    expect(audioOutput.register).toHaveBeenCalledOnceWith(video); expect(video.getAttribute('src')).toBe('/recording.webm');
    fixture.destroy(); expect(audioOutput.register.calls.mostRecent().returnValue).toHaveBeenCalled();
  });
});
