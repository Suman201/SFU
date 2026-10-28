import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ProfileService } from '../../core/services/profile.service';
import type { TutorOnboardingNotice } from '@native-sfu/contracts';
@Component({
  selector: 'sfu-tutor-notices',
  standalone: true,
  imports: [RouterLink],
  template: ` <div class="notices">
    <button
      type="button"
      class="notice-trigger"
      [attr.aria-expanded]="open()"
      (click)="toggle()"
      aria-label="Application updates"
    >
      Updates
      @if (unread()) {
        <span>{{ unread() }}</span>
      }
    </button>
    @if (open()) {
      <section class="notice-panel" aria-label="Application notifications">
        <header>
          <strong>Application updates</strong
          ><button type="button" (click)="refresh()">Refresh</button>
        </header>
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
        @for (notice of notices(); track notice.id) {
          <article [class.unread]="!notice.readAt">
            <strong>{{ notice.title }}</strong>
            <p>{{ notice.body }}</p>
            <small>{{ date(notice.createdAt) }}</small>
            <footer>
              <a routerLink="/teacher/profile" (click)="open.set(false)"
                >Open profile</a
              >
              @if (!notice.readAt) {
                <button type="button" (click)="markRead(notice)">
                  Mark read
                </button>
              }
            </footer>
          </article>
        } @empty {
          <p>No application updates yet.</p>
        }
      </section>
    }
  </div>`,
  styles: [
    `
      :host {
        position: relative;
      }
      .notice-trigger {
        font: inherit;
        font-size: 12px;
        padding: 10px 12px;
        border: 1px solid var(--line, #dce4de);
        border-radius: 9px;
        background: var(--panel, #fff);
        color: var(--text, #173f35);
        cursor: pointer;
      }
      .notice-trigger span {
        padding: 2px 6px;
        margin-left: 5px;
        border-radius: 20px;
        background: #458b73;
        color: white;
      }
      .notice-panel {
        position: absolute;
        right: 0;
        top: 45px;
        width: min(360px, calc(100vw - 40px));
        max-height: 65vh;
        overflow: auto;
        background: var(--panel, #fff);
        color: var(--text, #173f35);
        border: 1px solid var(--line, #dce4de);
        border-radius: 12px;
        padding: 16px;
        box-shadow: 0 12px 35px #173f351a;
        z-index: 100;
      }
      header,
      footer {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: center;
      }
      article {
        padding: 15px 0;
        border-bottom: 1px solid var(--line, #dce4de);
      }
      article.unread {
        border-left: 3px solid #458b73;
        padding-left: 12px;
      }
      p {
        font-size: 12px;
        line-height: 1.6;
        margin: 8px 0;
      }
      small {
        font-size: 10px;
        opacity: 0.7;
      }
      footer {
        margin-top: 9px;
      }
      button,
      a {
        font: inherit;
        font-size: 11px;
        color: inherit;
      }
      footer button,
      header button {
        border: 0;
        background: transparent;
        text-decoration: underline;
        cursor: pointer;
      }
    `,
  ],
})
export class TutorNotices {
  private readonly api = inject(ProfileService);
  private readonly destroy = inject(DestroyRef);
  protected readonly notices = signal<TutorOnboardingNotice[]>([]);
  protected readonly open = signal(false);
  protected readonly error = signal('');
  protected unread() {
    return this.notices().filter((n) => !n.readAt).length;
  }
  constructor() {
    this.refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') this.refresh();
    }, 30000);
    this.destroy.onDestroy(() => clearInterval(timer));
  }
  protected toggle() {
    this.open.update((v) => !v);
    if (this.open()) this.refresh();
  }
  protected refresh() {
    this.api.tutorNotices().subscribe({
      next: (n) => {
        this.notices.set(n);
        this.error.set('');
      },
      error: () => {
        if (this.open()) this.error.set('Updates could not load. Try Refresh.');
      },
    });
  }
  protected markRead(notice: TutorOnboardingNotice) {
    this.api
      .readTutorNotice(notice.id)
      .subscribe({
        next: () =>
          this.notices.update((rows) =>
            rows.map((n) =>
              n.id === notice.id
                ? { ...n, readAt: new Date().toISOString() }
                : n,
            ),
          ),
        error: () =>
          this.error.set('The update could not be marked read. Try again.'),
      });
  }
  protected date(value: string) {
    return new Date(value).toLocaleString();
  }
}
