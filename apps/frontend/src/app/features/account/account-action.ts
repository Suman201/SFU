import { Component, DestroyRef, inject, signal } from '@angular/core';
import { Meta } from '@angular/platform-browser';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AccountApi } from '../../core/services/account-api.service';
import { AuthService } from '../../core/services/auth.service';
import { paymentErrorMessage } from '../../core/services/payments.service';
import { Header } from '../../shared/header/header';
import { Footer } from '../../shared/footer/footer';
@Component({ standalone: true, imports: [RouterLink, Header, Footer], selector: 'sfu-account-action', template: `
<sfu-header /><main class="pay-shell site-page account-shell"><section class="panel-card action-panel">
<p class="eyebrow">Account security</p><h1>{{ linking ? 'Connect sign-in method' : 'Confirm email address' }}</h1>
@if (!done() && !error()) { <p>{{ linking ? 'Connect this provider to the account and device where you started this request.' : 'Confirm this email address for your Sapiovian account. If your sign-in email changes, existing devices will be signed out.' }}</p> }
@if (error()) { <p class="notice error" role="alert">{{ error() }}</p> }
@if (done()) { <p class="notice success" role="status">{{ message() }}</p> }
@if (!done() && token) { <button class="action-button" type="button" [disabled]="busy()" (click)="finish()">{{ busy() ? 'Confirming…' : linking ? 'Connect provider' : 'Confirm email address' }}</button> }
@if (done() && !linking && changed()) { @if (otherAccount()) { <p>You are signed in to a different account.</p><button class="table-action" type="button" (click)="signInAgain()">Sign out and sign in to the updated account</button> } @else { <a [routerLink]="loginPath()">Sign in to your account</a> } }
<a routerLink="/account/settings">Return to account settings</a>
</section></main><sfu-footer />`, styleUrls: ['../payments/payment-pages.scss', './account.scss'], styles: '.action-panel{max-width:640px;width:100%;margin-inline:auto;box-sizing:border-box}.action-panel h1{font-size:28px;margin:0;color:var(--text)}' })
export class AccountAction {
  private readonly api = inject(AccountApi);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly linking = inject(ActivatedRoute).snapshot.data['mode'] === 'provider';
  protected readonly busy = signal(false); protected readonly error = signal(''); protected readonly done = signal(false); protected readonly message = signal(''); protected readonly changed = signal(false); protected readonly otherAccount = signal(false); protected readonly loginPath = signal('/student/login');
  protected readonly token: string | null;
  private readonly pending = this.api.pendingLink();
  constructor() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const value = fragment.get(this.linking ? 'ticket' : 'token');
    this.token = value && (this.linking ? /^[A-Za-z0-9_-]{43}$/ : /^[a-f0-9]{64}$/).test(value) ? value : null;
    history.replaceState(history.state, '', location.pathname + location.search);
    const meta = inject(Meta), previous = meta.getTag('name="referrer"')?.content;
    meta.updateTag({ name: 'referrer', content: 'no-referrer' });
    inject(DestroyRef).onDestroy(() => { if (previous) meta.updateTag({ name: 'referrer', content: previous }); else meta.removeTag('name="referrer"'); });
    if (!this.token || (this.linking && !this.pending)) this.error.set(fragment.get('error') === 'cancelled' ? 'The connection was cancelled. You can start again from account settings.' : 'This link expired or belongs to another browser. Start again from account settings.');
  }
  protected async finish(): Promise<void> {
    if (!this.token || this.busy() || this.done()) return;
    this.busy.set(true); this.error.set('');
    try {
      if (this.linking && this.pending) { await firstValueFrom(this.api.completeLink(this.token, this.pending.verifier)); this.api.clearLink(); this.message.set('Sign-in method connected to your account.'); }
      else {
        const result = await firstValueFrom(this.api.confirmEmail(this.token)); this.changed.set(result.changed); this.loginPath.set('/' + result.role + '/login');
        if (result.changed) {
          if (!this.auth.user() || this.auth.user()?.id === result.accountId) this.auth.clearSession('Your email was changed. Sign in with your updated email.');
          else this.otherAccount.set(true);
        }
        this.message.set(result.changed ? 'Your sign-in email is updated. Previous devices were signed out. Use the new email to sign in.' : 'Your email address is verified.');
      }
      this.done.set(true);
    } catch (error) { this.error.set(paymentErrorMessage(error, 'This request could not be confirmed. Start again from account settings.')); }
    finally { this.busy.set(false); }
  }
  protected signInAgain(): void { this.auth.logout(); void this.router.navigateByUrl(this.loginPath()); }
}
