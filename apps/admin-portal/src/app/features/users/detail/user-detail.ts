import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import type { AdminUserDetail, AdminUserRole, AdminUserStatus, AdminUserUpdateRequest } from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

@Component({
  selector: 'sfu-admin-user-detail',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './user-detail.html',
  styleUrl: './user-detail.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class UserDetail implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly user = signal<AdminUserDetail | null>(null);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly pendingAction = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly success = signal('');

  protected readonly form = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(120)]],
    displayName: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(120)]],
    phone: ['', [Validators.maxLength(40)]],
    role: ['student' as AdminUserRole],
    status: ['active' as AdminUserStatus],
    disabled: [false]
  });

  ngOnInit(): void {
    this.load();
  }

  protected save(): void {
    const user = this.user();
    if (!user || this.form.invalid || this.saving()) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    const request: AdminUserUpdateRequest = {
      name: value.name.trim(),
      displayName: value.displayName.trim(),
      phone: value.phone.trim(),
      roles: [value.role],
      status: value.status,
      disabled: value.disabled
    };
    this.saving.set(true);
    this.error.set('');
    this.success.set('');
    this.api
      .updateUser(user.id, request)
      .pipe(finalize(() => this.saving.set(false)))
      .subscribe({
        next: (updated) => {
          this.user.set(updated);
          this.patchForm(updated);
          this.success.set(`${updated.name} updated.`);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  protected activate(): void {
    this.runAction('activate');
  }

  protected deactivate(): void {
    const user = this.user();
    if (!user || !confirm(`Deactivate ${user.name}? They will be signed out and blocked from logging in until reactivated.`)) {
      return;
    }
    this.runAction('deactivate');
  }

  protected statusClass(user: AdminUserDetail): string {
    return `status-${user.status}`;
  }

  protected roleClass(role: AdminUserRole): string {
    return `role-${role}`;
  }

  protected roleLabel(role: AdminUserRole): string {
    return role.replace('_', ' ');
  }

  private runAction(action: 'activate' | 'deactivate'): void {
    const user = this.user();
    if (!user || this.pendingAction()) {
      return;
    }
    this.pendingAction.set(action);
    this.error.set('');
    this.success.set('');
    const request = action === 'activate' ? this.api.activateUser(user.id) : this.api.deactivateUser(user.id);
    request.pipe(finalize(() => this.pendingAction.set(null))).subscribe({
      next: (response) => {
        this.user.set(response.user);
        this.patchForm(response.user);
        this.success.set(`${response.user.name} ${response.action}.`);
      },
      error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
    });
  }

  private load(): void {
    const userId = this.route.snapshot.paramMap.get('userId');
    if (!userId) {
      this.error.set('User id is missing.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.api
      .getUser(userId)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (user) => {
          this.user.set(user);
          this.patchForm(user);
        },
        error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
      });
  }

  private patchForm(user: AdminUserDetail): void {
    this.form.reset({
      name: user.name,
      displayName: user.displayName || user.name,
      phone: user.phone || '',
      role: user.primaryRole,
      status: user.status,
      disabled: user.disabled
    });
  }
}
