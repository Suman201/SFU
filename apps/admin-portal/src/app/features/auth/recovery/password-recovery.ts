import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AccountRecoveryForm } from '../../../../../../frontend/src/app/shared/account-recovery/account-recovery-form';
import { API_BASE_URL } from '../../../core/services/app-environment';
import { AuthService } from '../../../core/services/auth.service';

@Component({
  standalone: true, imports: [AccountRecoveryForm],
  template: `<main class="login-page"><header class="login-brand"><img class="sapiovian-logo" src="/brand/sapiovian-lockup.png" alt="Sapiovian" width="1736" height="468"></header><section class="login-panel" aria-label="Admin account recovery"><sfu-account-recovery-form [apiBaseUrl]="apiBase" [mode]="mode" loginPath="/login" (completed)="auth.clearSession()" /></section><footer>Sapiovian · Admin portal</footer></main>`,
  styleUrl: '../login/login.scss',
})
export class AdminPasswordRecovery {
  protected readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  protected readonly apiBase = API_BASE_URL;
  protected readonly mode: 'request' | 'reset' = this.route.snapshot.data['mode'] === 'reset' ? 'reset' : 'request';
}
