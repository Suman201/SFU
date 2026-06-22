import { Directive, ElementRef, Input, OnChanges } from '@angular/core';

@Directive({
  selector: 'audio[sfuMediaStream], video[sfuMediaStream]',
  standalone: true
})
export class MediaStreamDirective implements OnChanges {
  @Input('sfuMediaStream') stream: MediaStream | null = null;

  constructor(private readonly element: ElementRef<HTMLMediaElement>) {}

  ngOnChanges(): void {
    const target = this.element.nativeElement;
    if (target.srcObject !== this.stream) {
      target.srcObject = this.stream;
    }
  }
}
