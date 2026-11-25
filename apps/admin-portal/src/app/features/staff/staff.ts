import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { finalize } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type {
  AdminPortalPermission,
  AdminStaffMember,
  AdminStaffRole,
  AdminStaffRoleInput,
} from '@native-sfu/contracts';
import {
  AdminOperationsApi,
  adminOperationError,
} from '../../core/services/admin-operations-api.service';
import { ConfirmDialogService } from '../../shared/confirm-dialog/confirm-dialog.service';
@Component({
  selector: 'sfu-admin-staff',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './staff.html',
  styleUrl: '../../shared/admin-operations.scss',
})
export class AdminStaff {
  private readonly api = inject(AdminOperationsApi);
  private readonly destroy = inject(DestroyRef);
  private readonly confirm = inject(ConfirmDialogService);
  protected readonly roles = signal<AdminStaffRole[]>([]);
  protected readonly permissions = signal<string[]>([]);
  protected readonly members = signal<{
    items: AdminStaffMember[];
    total: number;
    page: number;
    limit: number;
  }>({ items: [], total: 0, page: 1, limit: 25 });
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly editorOpen = signal(false);
  protected editingId = '';
  protected form: AdminStaffRoleInput = {
    name: '',
    description: '',
    status: 'active',
    permissions: ['admin:dashboard:read'],
  };
  protected search = '';
  protected readonly assignment = signal<AdminStaffMember | null>(null);
  protected roleId = '';
  protected reason = '';
  constructor() {
    this.load();
    this.loadMembers();
    this.api
      .permissions()
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (items) => this.permissions.set(items),
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  private load() {
    this.api
      .roles()
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (items) => this.roles.set(items),
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected loadMembers(page = 1) {
    this.api
      .staff(this.search, page)
      .pipe(takeUntilDestroyed(this.destroy))
      .subscribe({
        next: (value) => this.members.set(value),
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected edit(role?: AdminStaffRole) {
    this.editingId = role?.id ?? '';
    this.form = role
      ? {
          name: role.name,
          description: role.description,
          status: role.status,
          permissions: [...role.permissions],
          version: role.version,
        }
      : {
          name: '',
          description: '',
          status: 'active',
          permissions: ['admin:dashboard:read'],
        };
    this.editorOpen.set(true);
    this.error.set('');
  }
  protected toggle(permission: string, checked: boolean) {
    const value = permission as AdminPortalPermission;
    const values = new Set(this.form.permissions);
    if (checked) {
      values.add(value);
      const read = permission.replace(
        /:(?:write|restore|refund|reconcile)$/,
        ':read',
      ) as AdminPortalPermission;
      if (read !== value) values.add(read);
    } else {
      values.delete(value);
      if (permission.endsWith(':read'))
        for (const current of [...values])
          if (current.startsWith(permission.slice(0, -4)))
            values.delete(current);
    }
    this.form.permissions = [...values];
  }
  protected label(permission: string) {
    return permission
      .replace(/^admin:/, '')
      .split(':')
      .map((word) =>
        word === 'read' ? 'View' : word[0]!.toUpperCase() + word.slice(1),
      )
      .join(' · ');
  }
  protected async save(event: SubmitEvent) {
    event.preventDefault();
    if (this.busy() || !(event.target as HTMLFormElement).reportValidity())
      return;
    const affected =
      this.roles().find((role) => role.id === this.editingId)?.assignedUsers ??
      0;
    if (
      !(await this.confirm.confirm({
        title: this.editingId
          ? 'Update staff access role?'
          : 'Create staff access role?',
        message: affected
          ? `${affected} assigned staff account(s) will use these permissions immediately.`
          : 'This role controls the selected administrative modules and actions.',
        confirmLabel: 'Save role',
        variant: this.form.status === 'inactive' ? 'danger' : 'neutral',
      }))
    )
      return;
    this.busy.set(true);
    this.api
      .saveRole(this.form, this.editingId || undefined)
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: () => {
          this.editorOpen.set(false);
          this.notice.set('Staff access role saved.');
          this.load();
          this.loadMembers(this.members().page);
        },
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected async remove(role: AdminStaffRole) {
    if (
      !(await this.confirm.confirm({
        title: 'Delete unassigned role?',
        message: 'Only roles with no staff assignments can be deleted.',
        confirmLabel: 'Delete role',
        variant: 'danger',
      }))
    )
      return;
    this.busy.set(true);
    this.api
      .deleteRole(role.id)
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: () => {
          this.load();
          this.notice.set('Unassigned role deleted.');
        },
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
  protected select(member: AdminStaffMember) {
    this.assignment.set(member);
    this.roleId = member.adminRoleId ?? '';
    this.reason = '';
    this.error.set('');
  }
  protected async assign(event: SubmitEvent) {
    event.preventDefault();
    const member = this.assignment();
    if (
      !member ||
      this.busy() ||
      !(event.target as HTMLFormElement).reportValidity()
    )
      return;
    const role = this.roles().find((item) => item.id === this.roleId);
    if (
      !(await this.confirm.confirm({
        title: 'Change staff access?',
        message: `${member.name} will ${role ? 'use ' + role.name : 'receive unrestricted administrator access'}. This takes effect on the next request.`,
        confirmLabel: 'Change access',
        variant: role ? 'neutral' : 'danger',
      }))
    )
      return;
    this.busy.set(true);
    this.api
      .assignRole(
        member.id,
        this.roleId || null,
        member.adminRoleId ?? null,
        this.reason.trim(),
      )
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroy),
      )
      .subscribe({
        next: () => {
          this.assignment.set(null);
          this.notice.set('Staff access updated and audited.');
          this.load();
          this.loadMembers(this.members().page);
        },
        error: (error) => this.error.set(adminOperationError(error)),
      });
  }
}
