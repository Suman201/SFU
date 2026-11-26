import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { BehaviorSubject, EMPTY, catchError, exhaustMap, filter, finalize, map, switchMap, timeout, timer } from 'rxjs';
import type { ChatMessage } from '@native-sfu/contracts';
import { ClassSessionService } from './class-session.service';

interface ThreadTarget {
  sessionId: string;
  batchId: string;
  roomId: string;
  participantId?: string;
  visible: () => boolean;
}

/** One private thread per page; switching/closing cancels pending history requests. */
@Injectable()
export class PostClassThreadStore {
  private readonly api = inject(ClassSessionService);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly target = new BehaviorSubject<ThreadTarget | null>(null);
  private revision = 0;
  private readAt = '';
  private reading = false;
  readonly messages = signal<ChatMessage[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');

  constructor() {
    this.target.pipe(
      switchMap(target => target ? timer(this.messages().length ? 5000 : 0, 5000).pipe(
        filter(() => this.document.visibilityState === 'visible' && target.visible()),
        exhaustMap(() => {
          const revision = this.revision;
          this.loading.set(true);
          return this.api.getPostClassChatHistory(target.sessionId, {
            batchId: target.batchId, participantId: target.participantId, limit: 100
          }).pipe(
            timeout(10000),
            map(history => ({ history, revision })),
            catchError(() => { this.error.set('Replies could not refresh. Retrying automatically.'); return EMPTY; }),
            finalize(() => this.loading.set(false))
          );
        })
      ) : EMPTY),
      takeUntilDestroyed(this.destroyRef)
    ).subscribe(({ history, revision }) => {
      // A response started before a successful send must not remove that new message.
      if (revision !== this.revision) return;
      this.messages.set(history.messages);
      this.error.set('');
    });
  }

  open(target: ThreadTarget, messages: ChatMessage[] = []): void {
    this.revision++;
    this.readAt = '';
    this.reading = false;
    this.messages.set(messages);
    this.error.set('');
    this.target.next(target);
  }

  close(): void {
    this.revision++;
    this.target.next(null);
    this.messages.set([]);
    this.error.set('');
    this.loading.set(false);
  }

  append(message: ChatMessage): void {
    this.revision++;
    this.messages.update(messages => messages.some(item => item.id === message.id) ? messages : [...messages, message]);
  }

  markVisibleRead(container?: HTMLElement): void {
    const target = this.target.value;
    if (!target || !target.roomId || !container || this.reading || this.document.visibilityState !== 'visible' || !target.visible()) return;
    const bounds = container.getBoundingClientRect();
    const viewportHeight = this.document.defaultView?.innerHeight ?? 0;
    const visibleDates = Array.from(container.querySelectorAll<HTMLElement>('[data-message-created-at]'))
      .filter(element => {
        const box = element.getBoundingClientRect();
        return box.height > 0 && box.top < Math.min(viewportHeight, bounds.bottom) && box.bottom > Math.max(0, bounds.top);
      })
      .map(element => element.dataset['messageCreatedAt'] ?? '')
      .filter(value => Number.isFinite(Date.parse(value)))
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const latest = visibleDates.at(-1);
    if (!latest || (this.readAt && Date.parse(latest) <= Date.parse(this.readAt))) return;
    this.reading = true;
    this.api.markChatRead(target.sessionId, {
      batchId: target.batchId, roomId: target.roomId, participantId: target.participantId, scope: 'private', readAt: latest
    }).pipe(timeout(10000), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => { if (this.target.value === target) this.readAt = latest; },
      error: () => { if (this.target.value === target) this.reading = false; },
      complete: () => { if (this.target.value === target) this.reading = false; }
    });
  }
}

export function threadVisible(element?: HTMLElement): boolean {
  if (!element) return false;
  const box = element.getBoundingClientRect();
  return box.height > 0 && box.width > 0 && box.top < (element.ownerDocument.defaultView?.innerHeight ?? 0) && box.bottom > 0;
}
