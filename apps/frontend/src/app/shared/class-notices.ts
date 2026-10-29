import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CalendarApi } from '../core/services/calendar.service';
import { ClassNotice } from '@native-sfu/contracts';
import { isDesktopSession } from '../core/services/desktop-bridge';
@Component({
  selector: 'sfu-class-notices',
  standalone: true,
  imports: [RouterLink],
  template: ` <div class="updates" (keydown.escape)="open.set(false)">
    <button
      type="button"
      class="trigger"
      aria-label="Class notifications"
      [attr.aria-expanded]="open()"
      (click)="toggle()"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zm4 3h6"
        />
      </svg>
      Classes
      @if (unread()) {
        <b>{{ unread() }}</b>
      }
    </button>
    @if (open()) {
      <section class="panel" aria-label="Class notifications">
        <header>
          <strong>Class updates</strong
          ><button type="button" (click)="refresh()">Refresh</button>
        </header>
        @if (error()) {
          <p role="alert">{{ error() }}</p>
        }
        @for (n of notices(); track n.id) {
          <article [class.unread]="!n.readAt">
            <strong>{{ n.title }}</strong>
            <p>{{ n.body }}</p>
            <footer>
              <a [routerLink]="calendarPath" (click)="open.set(false)"
                >View calendar</a
              >
              @if (!n.readAt) {
                <button type="button" (click)="read(n)">Mark read</button>
              }
            </footer>
          </article>
        } @empty {
          <p>You’re all caught up. Your class updates will appear here.</p>
        }
      </section>
    }
  </div>`,
  styles: [
    `
      :host {
        position: relative;
        font-size: 12px;
      }
      .trigger {
        display: flex;
        gap: 7px;
        align-items: center;
        border: 1px solid var(--line, #dce4de);
        border-radius: 9px;
        background: var(--panel, #fff);
        padding: 10px;
        color: var(--text, #173f35);
        font: inherit;
        cursor: pointer;
      }
      .trigger b {
        background: #458b73;
        color: #fff;
        padding: 2px 5px;
        border-radius: 20px;
      }
      .panel {
        position: absolute;
        right: 0;
        top: 46px;
        width: min(370px, calc(100vw - 36px));
        max-height: 65vh;
        overflow: auto;
        background: var(--panel, #fff);
        border: 1px solid var(--line, #dce4de);
        color: var(--text, #173f35);
        border-radius: 12px;
        padding: 18px;
        box-shadow: 0 12px 35px #173f351a;
        z-index: 100;
      }
      header,
      footer {
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      article {
        padding: 16px 0;
        border-bottom: 1px solid var(--line, #dce4de);
      }
      article.unread {
        border-left: 3px solid #458b73;
        padding-left: 12px;
      }
      p {
        font-size: 12px;
        line-height: 1.7;
        margin: 8px 0;
      }
      button,
      a {
        font: inherit;
        color: inherit;
      }
      header button,
      footer button {
        border: 0;
        background: none;
        text-decoration: underline;
        cursor: pointer;
      }
      footer {
        font-size: 11px;
      }
    `,
  ],
})
export class ClassNotices {
  private readonly api = inject(CalendarApi);
  private readonly destroy = inject(DestroyRef);
  protected readonly open = signal(false);
  protected readonly notices = signal<ClassNotice[]>([]);
  protected readonly error = signal('');
  protected readonly calendarPath = isDesktopSession()
    ? '/desktop/calendar'
    : '/calendar';
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
    this.api.notices(!this.open()).subscribe({
      next: (n) => {
        this.notices.set(n);
        this.error.set('');
      },
      error: () => {
        if (this.open()) this.error.set('Updates could not load. Try Refresh.');
      },
    });
  }
  protected read(n: ClassNotice) {
    this.api
      .read(n.id)
      .subscribe({
        next: () =>
          this.notices.update((rows) =>
            rows.map((row) =>
              row.id === n.id
                ? { ...row, readAt: new Date().toISOString() }
                : row,
            ),
          ),
        error: () =>
          this.error.set('Could not mark this update read. Try again.'),
      });
  }
}
