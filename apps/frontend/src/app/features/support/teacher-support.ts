import { Component, OnInit, effect, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { SupportIssueType, SupportRequest, SupportRequestListResponse, SupportRequestStatus } from '@native-sfu/contracts';
import { SupportApi } from '../../core/services/support-api.service';
import { AuthService } from '../../core/services/auth.service';
import { paymentErrorMessage } from '../../core/services/payments.service';
import { Header } from '../../shared/header/header';
import { Footer } from '../../shared/footer/footer';
@Component({ standalone: true, selector: 'sfu-teacher-support', imports: [DatePipe, FormsModule, RouterLink, Header, Footer], templateUrl: './teacher-support.html', styleUrls: ['../payments/payment-pages.scss', './support-centre.scss'] })
export class TeacherSupport implements OnInit {
  private readonly api = inject(SupportApi); private readonly auth = inject(AuthService); private readonly route = inject(ActivatedRoute);
  protected readonly list = signal<SupportRequestListResponse | null>(null); protected readonly selected = signal<SupportRequest | null>(null);
  protected readonly error = signal(''); protected readonly success = signal(''); protected readonly busy = signal(false); protected readonly loading = signal(false);
  protected view: 'mine' | 'class' = 'mine'; protected status = 'all'; protected search = ''; protected subject = ''; protected message = ''; protected issueType: SupportIssueType = 'other'; protected reply = ''; protected nextStatus: '' | SupportRequestStatus = '';
  protected readonly contextual = Boolean(this.route.snapshot.queryParamMap.get('batchId') || this.route.snapshot.queryParamMap.get('sessionId'));
  private listVersion = 0; private threadVersion = 0;
  constructor() { effect(() => { if (!this.auth.user()) { this.listVersion++; this.threadVersion++; this.list.set(null); this.selected.set(null); this.subject = ''; this.message = ''; this.reply = ''; } }); }
  ngOnInit(): void { void this.load(); }
  protected label(value: string): string { return value.replaceAll('_', ' '); }
  protected changeView(view: 'mine' | 'class'): void { this.view = view; this.selected.set(null); this.threadVersion++; this.reply = ''; this.nextStatus = ''; void this.load(); }
  protected async load(page = 1): Promise<void> {
    const version = ++this.listVersion, owner = this.auth.user()?.id; this.loading.set(true); this.error.set('');
    try { const list = await firstValueFrom(this.api.list(page, this.view, this.status, this.search.trim())); if (version === this.listVersion && owner === this.auth.user()?.id) this.list.set(list); }
    catch (error) { if (version === this.listVersion) this.error.set(paymentErrorMessage(error, 'Support requests could not be loaded.')); }
    finally { if (version === this.listVersion) this.loading.set(false); }
  }
  protected async open(row: SupportRequest): Promise<void> {
    const version = ++this.threadVersion, owner = this.auth.user()?.id; if (row.requestId !== this.selected()?.requestId) { this.reply = ''; this.nextStatus = ''; } this.error.set('');
    try { const current = await firstValueFrom(this.api.get(row.requestId)); if (version === this.threadVersion && owner === this.auth.user()?.id) this.selected.set(current); }
    catch (error) { if (version === this.threadVersion) this.error.set(paymentErrorMessage(error, 'This conversation is unavailable.')); }
  }
  protected async submit(): Promise<void> {
    if (this.busy()) return; this.busy.set(true); this.error.set(''); this.success.set(''); const owner = this.auth.user()?.id;
    try { const batchId = this.route.snapshot.queryParamMap.get('batchId'), sessionId = this.route.snapshot.queryParamMap.get('sessionId'); const created = await firstValueFrom(this.api.create({ issueType: this.issueType, subject: this.subject.trim(), message: this.message.trim(), ...(batchId ? { batchId } : {}), ...(sessionId ? { sessionId } : {}) })); if (owner === this.auth.user()?.id) { this.subject = ''; this.message = ''; this.success.set('Support request opened.'); this.view = 'mine'; this.selected.set(created); await this.load(); } }
    catch (error) { this.error.set(paymentErrorMessage(error, 'Your request could not be opened.')); } finally { this.busy.set(false); }
  }
  protected async send(): Promise<void> {
    const row = this.selected(); if (!row || this.busy()) return; this.busy.set(true); this.error.set(''); this.success.set(''); const version = this.threadVersion, owner = this.auth.user()?.id;
    try { const updated = await firstValueFrom(this.api.reply(row, this.reply, this.view === 'class' && this.nextStatus ? this.nextStatus : undefined)); if (version === this.threadVersion && owner === this.auth.user()?.id) { this.selected.set(updated); this.reply = ''; this.nextStatus = ''; this.success.set('Conversation updated.'); await this.load(this.list()?.page); } }
    catch (error) { this.error.set(paymentErrorMessage(error, 'Your reply could not be saved. Reload the conversation and try again.')); } finally { this.busy.set(false); }
  }
}
