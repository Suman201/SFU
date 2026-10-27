import { AudioOutputService } from '../../core/services/audio-output.service';
import { Directive, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output } from '@angular/core';

@Directive({
  selector: 'audio[sfuMediaStream], video[sfuMediaStream], audio[sfuAudioOutput], video[sfuAudioOutput]',
  standalone: true
})
export class MediaStreamDirective implements OnChanges, OnDestroy {
  @Input('sfuMediaStream') stream: MediaStream | null = null;
  @Output() playbackBlocked = new EventEmitter<unknown>();

  private readonly unregisterOutput: () => void;
  constructor(private readonly element: ElementRef<HTMLMediaElement>, audioOutput: AudioOutputService = new AudioOutputService()) {
    this.unregisterOutput = audioOutput.register(element.nativeElement);
  }

  ngOnDestroy(): void { this.unregisterOutput(); }

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
