import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { ClassSessionService } from '../class-session/class-session.service';
import { DesktopRecordings } from './desktop-recordings';
import { DesktopService } from './desktop.service';

describe('Desktop recording playback recovery', () => {
  let component: DesktopRecordings;
  let playback: jasmine.Spy;
  const internal = () => component as unknown as {
    mediaError(): void;
    restorePosition(event: Event): void;
    playerError(): string;
  };

  beforeEach(() => {
    playback = jasmine.createSpy('playback').and.callFake(() => of({
      recordingId: 'lesson', playbackUrl: '/lesson.webm?ticket=current', mimeType: 'video/webm',
      durationSeconds: 3600, lastPositionSeconds: 0, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), materials: []
    }));
    TestBed.configureTestingModule({ providers: [
      { provide: DesktopService, useValue: { recordings: () => of({ items: [], total: 0 }), playback, progress: () => of({}) } },
      { provide: ClassSessionService, useValue: { errorMessage: () => 'Playback unavailable' } },
      { provide: ActivatedRoute, useValue: { queryParamMap: of(convertToParamMap({ recordingId: 'lesson' })) } },
      { provide: Router, useValue: { navigate: jasmine.createSpy('navigate') } }
    ] });
    component = TestBed.runInInjectionContext(() => new DesktopRecordings());
  });

  afterEach(() => component.ngOnDestroy());

  function loadedReplacement(): void {
    const video = document.createElement('video');
    Object.defineProperty(video, 'duration', { value: 3600 });
    video.addEventListener('loadedmetadata', (event) => internal().restorePosition(event));
    video.dispatchEvent(new Event('loadedmetadata'));
  }

  it('recovers another revoked ticket after the first replacement loaded successfully', () => {
    expect(playback).toHaveBeenCalledTimes(1);
    internal().mediaError();
    expect(playback).toHaveBeenCalledTimes(2);
    loadedReplacement();
    internal().mediaError();
    expect(playback).toHaveBeenCalledTimes(3);
    loadedReplacement();
    expect(internal().playerError()).toBe('');
  });

  it('does not loop when a refreshed ticket still cannot load media', () => {
    internal().mediaError();
    expect(playback).toHaveBeenCalledTimes(2);
    internal().mediaError();
    internal().mediaError();
    expect(playback).toHaveBeenCalledTimes(2);
    expect(internal().playerError()).toContain('could not be played');
  });
});
