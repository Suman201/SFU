import { ClassNotices } from '../class-notices';
import { TutorNotices } from '../tutor-notices/tutor-notices';
import { BrandLogo } from '../brand-mark/brand-logo';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { ThemeService } from '../../core/services/theme.service';

@Component({
  selector: 'sfu-header',
  standalone: true,
  imports: [BrandLogo, RouterLink, RouterLinkActive, TutorNotices, ClassNotices],
  templateUrl: './header.html',
  styleUrl: './header.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class Header {
  private readonly menuButton =
    viewChild<ElementRef<HTMLButtonElement>>('menuButton');
  protected readonly menuOpen = signal(false);
  protected readonly isScrolled = signal(false);

  @HostListener('window:scroll')
  onWindowScroll(): void {
    const scrollY = typeof window !== 'undefined' ? window.scrollY : 0;
    this.isScrolled.set(scrollY > 20);
  }
  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }
  protected closeMenu(): void {
    this.menuOpen.set(false);
  }
  protected escapeMenu(): void {
    if (!this.menuOpen()) return;
    this.closeMenu();
    this.menuButton()?.nativeElement.focus();
  }

  protected readonly auth = inject(AuthService);
  protected readonly theme = inject(ThemeService);
  private readonly router = inject(Router);

  protected logout(): void {
    this.closeMenu();
    const role = this.auth.role() ?? 'student';
    this.auth.logout();
    void this.router.navigate([`/${role}/login`]);
  }

  protected toggleTheme(): void {
    this.theme.toggle();
  }
}
