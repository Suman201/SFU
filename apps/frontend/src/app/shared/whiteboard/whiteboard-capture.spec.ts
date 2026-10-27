import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Whiteboard } from './whiteboard';

describe('Static classroom whiteboard video capture', () => {
  let fixture: ComponentFixture<Whiteboard>;
  let video: HTMLVideoElement | undefined;
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [Whiteboard] }).compileComponents();
    fixture = TestBed.createComponent(Whiteboard);
    fixture.nativeElement.style.width = '960px';
    fixture.nativeElement.style.height = '540px';
    fixture.detectChanges();
  });
  afterEach(() => { video?.pause(); video?.remove(); fixture.destroy(); });

  it('continues delivering real browser video frames while the board is unchanged', async () => {
    const board = fixture.componentInstance;
    const before = board.exportBoardState();
    const stream = board.captureMediaStream()!;
    expect(stream.getVideoTracks().length).toBe(1);
    video = document.createElement('video');
    video.muted = true; video.autoplay = true; video.srcObject = stream;
    document.body.appendChild(video);
    await video.play();
    const initialFrames = video.getVideoPlaybackQuality().totalVideoFrames;
    await new Promise((resolve) => window.setTimeout(resolve, 1250));
    expect(video.videoWidth).toBeGreaterThan(0);
    expect(video.getVideoPlaybackQuality().totalVideoFrames).toBeGreaterThan(initialFrames);
    expect(board.exportBoardState()).toEqual(before);
    board.stopMediaCapture();
    expect(stream.getVideoTracks()[0]!.readyState).toBe('ended');
  });

  it('releases refresh work and tracks on restart, track end and destruction', () => {
    jasmine.clock().install();
    try {
      const board = fixture.componentInstance;
      const render = spyOn(board as any, 'render').and.callThrough();
      const first = board.captureMediaStream()!;
      const second = board.captureMediaStream()!;
      expect(first.getVideoTracks()[0]!.readyState).toBe('ended');
      const afterRestart = render.calls.count();
      jasmine.clock().tick(1000);
      expect(render.calls.count()).toBe(afterRestart + 1);
      second.getVideoTracks()[0]!.dispatchEvent(new Event('ended'));
      const afterEnd = render.calls.count();
      jasmine.clock().tick(2000);
      expect(render.calls.count()).toBe(afterEnd);
      const third = board.captureMediaStream()!;
      fixture.destroy();
      const afterDestroy = render.calls.count();
      jasmine.clock().tick(2000);
      expect(render.calls.count()).toBe(afterDestroy);
      expect(third.getVideoTracks()[0]!.readyState).toBe('ended');
    } finally { jasmine.clock().uninstall(); }
  });
});
