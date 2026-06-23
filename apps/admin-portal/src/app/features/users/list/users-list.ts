import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  AdminUserListItem,
  AdminUserListQuery,
  AdminUserRole,
  AdminUserSort,
  AdminUserStatus,
  AdminUserSummary
} from '@native-sfu/contracts';
import { finalize } from 'rxjs';
import { AdminApiService } from '../../../core/services/admin-api.service';

type UserRoleFilter = AdminUserRole | 'all';
type UserStatusFilter = AdminUserStatus | 'all';

@Component({
  selector: 'sfu-admin-users-list',
  standalone: true,
  imports: [DatePipe, ReactiveFormsModule, RouterLink],
  templateUrl: './users-list.html',
  styleUrl: './users-list.scss',
  changeDetection: ChangeDetectionStrategy.Eager
})
export class UsersList implements OnInit {
  private readonly api = inject(AdminApiService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly rows = signal<AdminUserListItem[]>([]);
  protected readonly summary = signal<AdminUserSummary | null>(null);
  protected readonly loading = signal(false);
  protected readonly pendingUserId = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly success = signal('');
  protected readonly page = signal(1);
  protected readonly limit = signal(25);
  protected readonly total = signal(0);

  protected readonly filters = this.formBuilder.nonNullable.group({
    role: ['all' as UserRoleFilter],
    status: ['all' as UserStatusFilter],
    search: [''],
    sort: ['created_desc' as AdminUserSort],
    limit: [25]
  });

  private loadToken = 0;

  ngOnInit(): void {
    this.readQueryParams();
    this.load(this.page());
  }

  protected applyFilters(): void {
    void this.updateQueryAndLoad(1);
  }

  protected resetFilters(): void {
    this.filters.reset({
      role: 'all',
      status: 'all',
      search: '',
      sort: 'created_desc',
      limit: 25
    });
    void this.updateQueryAndLoad(1);
  }

  protected activate(row: AdminUserListItem): void {
    this.runAction(row, 'activate');
  }

  protected deactivate(row: AdminUserListItem): void {
    if (!confirm(`Deactivate ${row.name}? They will be signed out and blocked from logging in until reactivated.`)) {
      return;
    }
    this.runAction(row, 'deactivate');
  }

  protected nextPage(): void {
    if (this.page() * this.limit() < this.total()) {
      void this.updateQueryAndLoad(this.page() + 1);
    }
  }

  protected previousPage(): void {
    if (this.page() > 1) {
      void this.updateQueryAndLoad(this.page() - 1);
    }
  }

  protected initials(row: AdminUserListItem): string {
    return (row.name || row.email)
      .split(/\s+/)
      .map((part) => part.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  protected roleLabel(role: AdminUserRole): string {
    return role.replace('_', ' ');
  }

  protected statusClass(status: AdminUserStatus): string {
    return `status-${status}`;
  }

  protected roleClass(role: AdminUserRole): string {
    return `role-${role}`;
  }

  protected trackByUser(_index: number, row: AdminUserListItem): string {
    return row.id;
  }

  private runAction(row: AdminUserListItem, action: 'activate' | 'deactivate'): void {
    if (this.pendingUserId()) {
      return;
    }
    this.pendingUserId.set(row.id);
    this.error.set('');
    this.success.set('');
    const request = action === 'activate' ? this.api.activateUser(row.id) : this.api.deactivateUser(row.id);
    request.pipe(finalize(() => this.pendingUserId.set(null))).subscribe({
      next: (response) => {
        this.success.set(`${response.user.name} ${response.action}.`);
        this.load();
      },
      error: (error: unknown) => this.error.set(this.api.apiErrorMessage(error))
    });
  }

  private load(page = this.page()): void {
    const token = ++this.loadToken;
    this.loading.set(true);
    this.error.set('');
    this.api
      .listUsers(this.toQuery(page))
      .pipe(finalize(() => token === this.loadToken && this.loading.set(false)))
      .subscribe({
        next: (response) => {
          if (token !== this.loadToken) {
            return;
          }
          this.rows.set(response.items);
          this.summary.set(response.summary);
          this.page.set(response.page);
          this.limit.set(response.limit);
          this.total.set(response.total);
        },
        error: (error: unknown) => {
          if (token === this.loadToken) {
            this.error.set(this.api.apiErrorMessage(error));
          }
        }
      });
  }

  private async updateQueryAndLoad(page: number): Promise<void> {
    await this.router.navigate([], {
      relativeTo: this.route,
      queryParams: this.queryParams(page)
    });
    this.load(page);
  }

  private readQueryParams(): void {
    const params = this.route.snapshot.queryParamMap;
    const page = Number(params.get('page') ?? '1');
    const limit = Number(params.get('limit') ?? '25');
    this.page.set(Number.isFinite(page) && page > 0 ? Math.floor(page) : 1);
    this.limit.set(Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 25);
    this.filters.reset({
      role: this.toRoleFilter(params.get('role')),
      status: this.toStatusFilter(params.get('status')),
      search: params.get('search') ?? '',
      sort: this.toSort(params.get('sort')),
      limit: this.limit()
    });
  }

  private queryParams(page: number): Record<string, string | number> {
    const query = this.toQuery(page);
    return Object.entries(query).reduce<Record<string, string | number>>((params, [key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        params[key] = value;
      }
      return params;
    }, {});
  }

  private toQuery(page: number): AdminUserListQuery {
    const value = this.filters.getRawValue();
    return {
      page,
      limit: Number(value.limit) || this.limit(),
      sort: value.sort,
      ...(value.role !== 'all' ? { role: value.role } : {}),
      ...(value.status !== 'all' ? { status: value.status } : {}),
      ...(value.search.trim() ? { search: value.search.trim() } : {})
    };
  }

  private toRoleFilter(value: string | null): UserRoleFilter {
    return value === 'teacher' || value === 'student' || value === 'admin' || value === 'super_admin' ? value : 'all';
  }

  private toStatusFilter(value: string | null): UserStatusFilter {
    return value === 'active' || value === 'inactive' || value === 'suspended' || value === 'invited' ? value : 'all';
  }

  private toSort(value: string | null): AdminUserSort {
    if (value === 'created_asc' || value === 'name_asc' || value === 'email_asc' || value === 'last_login_desc') {
      return value;
    }
    return 'created_desc';
  }
}
