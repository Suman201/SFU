import {
  ChangeDetectionStrategy,
  Component,
  afterNextRender,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { FormsModule } from '@angular/forms';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';
import { AdminIcon, type AdminIconName } from '../../shared/admin-icon';
interface NavigationItem {
  label: string;
  path: string;
  icon: AdminIconName;
}
const groups: { label: string; items: NavigationItem[] }[] = [
  {
    label: 'Workspace',
    items: [{ label: 'Dashboard', path: '/dashboard', icon: 'dashboard' }],
  },
  {
    label: 'Teaching',
    items: [
      { label: 'Class sessions', path: '/class-sessions', icon: 'calendar' },
      { label: 'Courses', path: '/courses', icon: 'book' },
      { label: 'Batches', path: '/batches', icon: 'layers' },
      { label: 'Enrollments', path: '/enrollments', icon: 'check' },
      { label: 'Attendance', path: '/attendance', icon: 'chart' },
      { label: 'Recordings', path: '/recordings', icon: 'video' },
      { label: 'Class library', path: '/class-library', icon: 'folder' },
    ],
  },
  {
    label: 'People & curriculum',
    items: [
      { label: 'Users', path: '/users', icon: 'users' },
      {
        label: 'Tutor applications',
        path: '/tutor-applications',
        icon: 'shield',
      },
      {
        label: 'Subjects & categories',
        path: '/teaching-catalog',
        icon: 'archive',
      },
    ],
  },
  {
    label: 'Business',
    items: [
      { label: 'Invoices', path: '/invoices', icon: 'receipt' },
      { label: 'Support', path: '/support', icon: 'support' },
      { label: 'Contact inbox', path: '/cms/contact', icon: 'mail' },
      { label: 'Promotions', path: '/teacher-promotions', icon: 'tag' },
      { label: 'CMS', path: '/cms/pages', icon: 'file' },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Audit logs', path: '/audit-logs', icon: 'shield' },
      { label: 'Error log', path: '/errors', icon: 'alert' },
      {
        label: 'Error Encyclopedia',
        path: '/error-encyclopedia',
        icon: 'help',
      },
    ],
  },
];
@Component({
  selector: 'sfu-admin-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, FormsModule, AdminIcon],
  templateUrl: './admin-shell.html',
  styleUrl: './admin-shell.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminShell {
  protected readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly destroy = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private previousOverflow = '';
  readonly navPanel = viewChild<ElementRef<HTMLElement>>('navPanel');
  readonly navTrigger = viewChild<ElementRef<HTMLButtonElement>>('navTrigger');
  protected readonly collapsed = signal(this.storedCollapse());
  protected readonly mobileOpen = signal(false);
  protected readonly query = signal('');
  protected readonly currentUrl = signal(this.router.url);
  protected readonly filteredGroups = computed(() => {
    const query = this.query().trim().toLowerCase();
    return groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          `${item.label} ${group.label}`.toLowerCase().includes(query),
        ),
      }))
      .filter((group) => group.items.length);
  });
  protected readonly section = computed(() =>
    groups.find((group) =>
      group.items.some((item) =>
        (this.currentUrl().split('?')[0] ?? '').startsWith(item.path),
      ),
    ),
  );
  protected readonly currentPage = computed(
    () =>
      this.section()?.items.find((item) =>
        (this.currentUrl().split('?')[0] ?? '').startsWith(item.path),
      )?.label ?? 'Administration',
  );
  protected readonly initials = computed(() =>
    (this.auth.user()?.name || 'Administrator')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase(),
  );
  protected readonly role = computed(() =>
    this.auth.user()?.roles.includes('SUPER_ADMIN')
      ? 'Super admin'
      : 'Administrator',
  );
  constructor() {
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        const wasOpen = this.mobileOpen();
        this.currentUrl.set(this.router.url);
        this.query.set('');
        this.closeMobile(false);
        if (wasOpen)
          afterNextRender(
            () => document.getElementById('workspace-content')?.focus(),
            { injector: this.injector },
          );
      });
    const media = globalThis.matchMedia?.('(min-width: 961px)');
    const resized = () => {
      if (media?.matches) this.closeMobile(false);
    };
    media?.addEventListener('change', resized);
    this.destroy.onDestroy(() => {
      media?.removeEventListener('change', resized);
      if (this.mobileOpen())
        document.body.style.overflow = this.previousOverflow;
    });
  }
  protected toggleCollapse(): void {
    this.collapsed.update((value) => !value);
    this.query.set('');
    try {
      localStorage.setItem(
        'sapiovian.admin.navCollapsed',
        String(this.collapsed()),
      );
    } catch {
      /* Storage is optional. */
    }
  }
  protected openMobile(): void {
    this.previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    this.mobileOpen.set(true);
    afterNextRender(
      () =>
        this.navPanel()
          ?.nativeElement.querySelector<HTMLButtonElement>('.mobile-close')
          ?.focus(),
      { injector: this.injector },
    );
  }
  protected closeMobile(restoreFocus = true): void {
    const wasOpen = this.mobileOpen();
    this.mobileOpen.set(false);
    if (wasOpen) document.body.style.overflow = this.previousOverflow;
    if (wasOpen && restoreFocus)
      afterNextRender(() => this.navTrigger()?.nativeElement.focus(), {
        injector: this.injector,
      });
  }
  protected trapNavigation(event: KeyboardEvent): void {
    if (!this.mobileOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeMobile();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = Array.from(
      this.navPanel()!.nativeElement.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input',
      ),
    ).filter((item) => item.getClientRects().length > 0);
    const first = items[0],
      last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  protected logout(): void {
    this.auth.logout();
    void this.router.navigate(['/login']);
  }
  private storedCollapse(): boolean {
    try {
      return localStorage.getItem('sapiovian.admin.navCollapsed') === 'true';
    } catch {
      return false;
    }
  }
}
