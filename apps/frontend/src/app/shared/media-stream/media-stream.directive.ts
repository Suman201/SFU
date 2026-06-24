import { Directive, ElementRef, EventEmitter, Input, OnChanges, Output } from '@angular/core';

@Directive({
  selector: 'audio[sfuMediaStream], video[sfuMediaStream]',
  standalone: true
})
export class MediaStreamDirective implements OnChanges {
  @Input('sfuMediaStream') stream: MediaStream | null = null;
  @Output() playbackBlocked = new EventEmitter<unknown>();

  constructor(private readonly element: ElementRef<HTMLMediaElement>) {}

  ngOnChanges(): void {
    const target = this.element.nativeElement;
    if (target.srcObject !== this.stream) {
      target.srcObject = this.stream;
    }
    if (!this.stream || !target.autoplay) {
      return;
    }
    const playback = target.play();
    if (playback && typeof playback.catch === 'function') {
      playback.catch((error: unknown) => this.playbackBlocked.emit(error));
    }
  }
}
