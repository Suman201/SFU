import { AfterViewInit, Directive, ElementRef, Input, OnDestroy, OnChanges, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { EXPECTED_ERROR_STATUSES } from '@sapiovian/error-ui';
import type { PromotionEventKind, PromotionTracking } from '@native-sfu/contracts';
import { API_BASE_URL } from '../../core/services/app-environment';
@Directive({ standalone: true, selector: '[sfuPromotionTracking]', host: { '(click)': 'click($event)' } })
export class PromotionTrackingDirective implements AfterViewInit, OnDestroy, OnChanges {
  @Input() sfuPromotionTracking?: PromotionTracking;
  private readonly element = inject(ElementRef<HTMLElement>); private readonly http = inject(HttpClient); private observer?: IntersectionObserver; private timer?: ReturnType<typeof setTimeout>; private readonly sent = new Set<string>();
  private ready = false; private destroyed = false;
  ngAfterViewInit() { this.ready = true; this.observe(); }
  ngOnChanges() { if (this.ready) queueMicrotask(() => { if (!this.destroyed) this.observe(); }); }
  private observe() { this.observer?.disconnect(); clearTimeout(this.timer); this.sent.clear(); if (!this.sfuPromotionTracking || typeof IntersectionObserver === 'undefined') return; this.observer = new IntersectionObserver(entries => { clearTimeout(this.timer); if (entries[0]?.isIntersecting && entries[0].intersectionRatio >= .5) this.timer = setTimeout(() => { if (document.visibilityState === 'visible') this.send('impression'); }, 1000); }, { threshold: [.5] }); this.observer.observe(this.element.nativeElement.querySelector('.profile-promotion-badge') ?? this.element.nativeElement); }
  protected click(event: MouseEvent) { const target = event.target as HTMLElement | null; const link = target?.closest('a,button,video'); if (!link) return; const kind = link.getAttribute('data-promotion-event') ?? this.element.nativeElement.getAttribute('data-promotion-event'); if (['profile_click','demo_open','booking_click'].includes(kind ?? '')) this.send(kind as PromotionEventKind); }
  private send(kind: PromotionEventKind) { const token = this.sfuPromotionTracking?.token; if (!token || this.sent.has(kind)) return; this.sent.add(kind); this.http.post(API_BASE_URL + '/promotion-commerce/events', { token, kind }, { context: new HttpContext().set(EXPECTED_ERROR_STATUSES, [400,403,429]) }).subscribe({ error: () => undefined }); }
  ngOnDestroy() { this.destroyed = true; clearTimeout(this.timer); this.observer?.disconnect(); }
}
