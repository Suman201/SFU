import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { API_BASE_URL } from '../../../core/services/app-environment';
import { AuthService } from '../../../core/services/auth.service';
import { AccountRecoveryForm } from '../../../shared/account-recovery/account-recovery-form';
import { AuthLayout } from '../auth-layout/auth-layout';

@Component({
  standalone: true, imports: [AuthLayout, AccountRecoveryForm],
  template: `<sfu-auth-layout [role]="role" title="Account recovery"><sfu-account-recovery-form [apiBaseUrl]="apiBase" [mode]="mode" [role]="role" [loginPath]="'/' + role + '/login'" (completed)="auth.clearSession()" /></sfu-auth-layout>`,
})
export class PasswordRecovery {
  protected readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  protected readonly apiBase = API_BASE_URL;
  protected readonly mode: 'request' | 'reset' = this.route.snapshot.data['mode'] === 'reset' ? 'reset' : 'request';
  protected readonly role: 'student' | 'teacher' = (new URLSearchParams(location.hash.slice(1)).get('role') ?? this.route.snapshot.queryParamMap.get('role')) === 'teacher' ? 'teacher' : 'student';
}
