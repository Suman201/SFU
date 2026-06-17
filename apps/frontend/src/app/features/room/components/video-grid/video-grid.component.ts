import { AfterViewInit, Component, ElementRef, Input, OnChanges, SimpleChanges, ViewChild, ChangeDetectionStrategy } from '@angular/core';
import type { Participant, Producer } from '@native-sfu/contracts';

@Component({
  selector: 'sfu-video-grid',
  standalone: true,
  template: `
    <section class="grid" [style.--tile-count]="participants.length || 1">
      <article class="tile local">
        <video #localVideo autoplay muted playsinline></video>
        <footer>
          <span>You</span>
          <span>{{ localStream ? 'Live' : 'Preview off' }}</span>
        </footer>
      </article>
      @for (participant of participants; track participant.id) {
        @if (participant.id !== localParticipantId) {
          <article class="tile">
            <div class="avatar">{{ initials(participant.displayName) }}</div>
            <footer>
              <span>{{ participant.displayName }}</span>
              <span>{{ status(participant) }}</span>
            </footer>
          </article>
        }
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.Eager,
  styles: [
    `
      .grid {
        min-height: 0;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        grid-auto-rows: minmax(180px, 1fr);
        gap: 10px;
      }

      .tile {
        position: relative;
        overflow: hidden;
        border-radius: var(--radius);
        background: var(--video-bg);
        border: 1px solid var(--video-border);
        min-height: 180px;
      }

      video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }

      .avatar {
        width: 100%;
        height: 100%;
        display: grid;
        place-items: center;
        color: var(--video-text);
        font-size: 42px;
        font-weight: 760;
        background: var(--video-avatar-bg);
      }

      footer {
        position: absolute;
        left: 8px;
        right: 8px;
        bottom: 8px;
        min-height: 32px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        border-radius: 6px;
        padding: 6px 8px;
        color: var(--video-text);
        background: var(--video-overlay);
        font-size: 12px;
      }
    `
  ]
})
export class VideoGridComponent implements AfterViewInit, OnChanges {
  @Input() participants: Participant[] = [];
  @Input() producers: Producer[] = [];
  @Input() localParticipantId: string | null = null;
  @Input() localStream: MediaStream | null = null;
  @ViewChild('localVideo') private readonly localVideo?: ElementRef<HTMLVideoElement>;

  ngAfterViewInit(): void {
    this.attachLocalStream();
  }

  ngOnChanges(_changes: SimpleChanges): void {
    this.attachLocalStream();
  }

  initials(name: string): string {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('');
  }

  status(participant: Participant): string {
    if (participant.screenSharing) {
      return 'Screen';
    }
    if (!participant.audioEnabled && !participant.videoEnabled) {
      return 'Muted';
    }
    return participant.videoEnabled ? 'Camera' : 'Audio only';
  }

  private attachLocalStream(): void {
    const video = this.localVideo?.nativeElement;
    if (video && video.srcObject !== this.localStream) {
      video.srcObject = this.localStream;
    }
  }
}
