import { Component, OnInit, effect, inject, signal } from '@angular/core';
import { isDesktopSession } from '../../core/services/desktop-bridge';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { AccountOverview, AccountSession, AccountSessionPage, ProfileSettings } from '@native-sfu/contracts';
import { AccountApi, accountDate } from '../../core/services/account-api.service';
import { AuthService } from '../../core/services/auth.service';
import { CurrencyService } from '../../core/services/currency.service';
import { ThemeService } from '../../core/services/theme.service';
import { paymentErrorMessage } from '../../core/services/payments.service';
import { SocialSignInService } from '../auth/social/social-sign-in.service';
import { Header } from '../../shared/header/header';
import { Footer } from '../../shared/footer/footer';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';

@Component({ standalone: true, selector: 'sfu-account-settings', imports: [FormsModule, RouterLink, Header, Footer], templateUrl: './account-settings.html', styleUrls: ['../payments/payment-pages.scss', './account.scss'] })
export class AccountSettings implements OnInit {
  private readonly api = inject(AccountApi);
  protected readonly auth = inject(AuthService);
  protected readonly currency = inject(CurrencyService);
  private readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly social = inject(SocialSignInService);
  protected readonly data = signal<AccountOverview | null>(null);
  protected readonly sessions = signal<AccountSessionPage | null>(null);
  protected readonly providers = signal({ google: false, apple: false });
  protected readonly busy = signal('');
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly loading = signal(true);
  protected readonly desktop = isDesktopSession();
  protected displayName = ''; protected phone = ''; protected timezone = '';
  protected themePreference: ProfileSettings['theme'] = 'system'; protected locale = 'en-GB';
  protected notificationEmail = true; protected classReminders = true; protected chatMessages = true; protected announcements = true; protected recordingReady = true;
  protected showEmail = false; protected allowMessages = true;
  protected currentPassword = ''; protected newPassword = ''; protected confirmPassword = '';
  protected email = ''; protected emailPassword = ''; protected providerPassword = '';
  constructor() { effect(() => { if (!this.auth.user()) { this.data.set(null); this.sessions.set(null); this.displayName = ''; this.phone = ''; this.timezone = ''; this.email = ''; this.currentPassword = ''; this.newPassword = ''; this.confirmPassword = ''; this.emailPassword = ''; this.providerPassword = ''; } }); }
  ngOnInit(): void {
    void this.load(); this.social.providers().subscribe({ next: value => this.providers.set(value), error: () => undefined });
  }
  private async load(): Promise<void> {
    const owner = this.auth.user()?.id;
    try {
      const data = await firstValueFrom(this.api.overview()); if (!owner || owner !== this.auth.user()?.id) return; this.data.set(data);
      this.displayName = data.profile.displayName; this.phone = data.profile.phone ?? ''; this.timezone = data.profile.timezone ?? '';
      this.email = data.security.email;
      const settings = data.profile.settings; this.themePreference = settings.theme; this.locale = settings.locale;
      this.notificationEmail = settings.notifications.email; this.classReminders = settings.notifications.classReminders; this.chatMessages = settings.notifications.chatMessages; this.announcements = settings.notifications.announcements; this.recordingReady = settings.notifications.recordingReady;
      this.showEmail = settings.privacy.showEmailOnPublicProfile; this.allowMessages = settings.privacy.allowTeacherMessages;
      await this.loadSessions();
    } catch (error) { this.error.set(paymentErrorMessage(error, 'Your account settings could not be loaded.')); }
    finally { this.loading.set(false); }
  }
  protected async loadSessions(page = 1): Promise<void> { const owner = this.auth.user()?.id; try { const sessions = await firstValueFrom(this.api.sessions(page)); if (owner && owner === this.auth.user()?.id) this.sessions.set(sessions); } catch (error) { this.error.set(paymentErrorMessage(error, 'Active sessions could not be loaded.')); } }
  protected date(value: string): string { return accountDate(value, this.data()?.profile.settings.locale, this.data()?.profile.timezone); }
  private async run(key: string, work: () => Promise<unknown>, message: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(key); this.error.set(''); this.success.set('');
    try { await work(); this.success.set(message); } catch (error) { this.error.set(paymentErrorMessage(error, error instanceof Error ? error.message : 'The account could not be updated.')); }
    finally { this.busy.set(''); }
  }
  protected saveDetails(): void {
    if (this.displayName.trim().length < 2) { this.error.set('Enter a display name with at least two characters.'); return; }
    void this.run('details', async () => { await firstValueFrom(this.api.profile({ displayName: this.displayName.trim(), phone: this.phone.trim(), timezone: this.timezone.trim() })); await firstValueFrom(this.auth.refreshUser()); await this.load(); }, 'Account details saved.');
  }
  protected savePreferences(): void {
    void this.run('preferences', async () => { await firstValueFrom(this.api.preferences({ theme: this.themePreference, locale: this.locale.trim() })); this.theme.setPreference(this.themePreference); await this.load(); }, 'Preferences saved.');
  }
  protected saveNotifications(): void {
    void this.run('notifications', async () => { await firstValueFrom(this.api.preferences({ notifications: { email: this.notificationEmail, classReminders: this.classReminders, chatMessages: this.chatMessages, announcements: this.announcements, recordingReady: this.recordingReady } })); await this.load(); }, 'Notification preferences saved.');
  }
  protected savePrivacy(): void {
    void this.run('privacy', async () => { await firstValueFrom(this.api.preferences({ privacy: { showEmailOnPublicProfile: this.showEmail, allowTeacherMessages: this.allowMessages } })); await this.load(); }, 'Privacy preferences saved.');
  }
  protected async changePassword(): Promise<void> {
    if (this.newPassword !== this.confirmPassword) { this.error.set('The new passwords must match.'); return; }
    if (this.newPassword.length < 10 || new TextEncoder().encode(this.newPassword).length > 72) { this.error.set('Use at least 10 characters and at most 72 UTF-8 bytes for your new password.'); return; }
    if (!await this.confirm.confirm({ title: 'Change your password?', message: 'All signed-in devices, including this one, will be signed out. You can sign in again with your new password.', confirmLabel: 'Change password and sign out', variant: 'warning' })) return;
    await this.run('password', async () => { try { await firstValueFrom(this.api.password(this.currentPassword, this.newPassword)); this.signOut('Your password was changed. Sign in with your new password.'); } finally { this.currentPassword = ''; this.newPassword = ''; this.confirmPassword = ''; } }, '');
  }
  protected requestEmail(): void { void this.run('email', async () => { try { await firstValueFrom(this.api.requestEmail(this.email.trim(), this.emailPassword)); await this.load(); } finally { this.emailPassword = ''; } }, 'Verification email queued. Open the newest link to confirm the email address.'); }
  protected cancelEmail(): void { void this.run('email', async () => { await firstValueFrom(this.api.cancelEmail()); await this.load(); }, 'Email change cancelled. Previous links will no longer work.'); }
  protected async revoke(row: AccountSession): Promise<void> {
    if (!await this.confirm.confirm({ title: row.current ? 'Sign out this device?' : 'Sign out this device?', message: `${row.device} will lose account access. Classroom connections close within 30 seconds.`, confirmLabel: 'Sign out device', variant: 'warning' })) return;
    await this.run('sessions', async () => { const result = await firstValueFrom(this.api.revoke(row.id)); if (result.current) this.signOut('This device was signed out.'); else await this.loadSessions(this.sessions()?.page); }, 'Device signed out.');
  }
  protected async revokeOthers(): Promise<void> {
    if (!await this.confirm.confirm({ title: 'Sign out other devices?', message: 'Keep this device signed in and sign out all your other devices.', confirmLabel: 'Sign out other devices', variant: 'warning' })) return;
    await this.run('sessions', async () => { await firstValueFrom(this.api.revokeOthers()); await this.loadSessions(); }, 'Other devices signed out.');
  }
  protected async connect(provider: 'google' | 'apple'): Promise<void> {
    await this.run('provider', async () => { try { await this.api.startLink(provider, this.providerPassword); } finally { this.providerPassword = ''; } }, '');
  }
  protected async disconnect(provider: 'google' | 'apple'): Promise<void> {
    if (!await this.confirm.confirm({ title: `Disconnect ${provider === 'google' ? 'Google' : 'Apple'}?`, message: 'Your password will remain available. All devices, including this one, will be signed out.', confirmLabel: 'Disconnect and sign out', variant: 'warning' })) return;
    await this.run('provider', async () => { try { await firstValueFrom(this.api.unlink(provider, this.providerPassword)); this.signOut('Sign-in method disconnected. Sign in with your password.'); } finally { this.providerPassword = ''; } }, '');
  }
  private signOut(message: string): void { const role = this.authRole(); this.auth.clearSession(message); void this.router.navigate(this.desktop ? ['/desktop/login'] : ['/', role, 'login'], { queryParams: { returnUrl: '/account/settings' }, replaceUrl: true }); }
  private authRole(): string { return this.data()?.profile.primaryRole ?? 'student'; }
}
