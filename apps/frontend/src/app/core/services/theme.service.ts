import { DOCUMENT } from '@angular/common';
import { Injectable, computed, effect, inject, signal } from '@angular/core';
import type { ProfileThemePreference } from '@native-sfu/contracts';

export type ThemePreference = ProfileThemePreference;
type EffectiveTheme = 'light' | 'dark';

const THEME_STORAGE_KEY = 'native-sfu-theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  readonly theme = signal<ThemePreference>(this.resolveInitialTheme());
  readonly effectiveTheme = computed<EffectiveTheme>(() => (this.theme() === 'system' ? this.systemTheme() : this.theme() as EffectiveTheme));
  readonly isDark = computed(() => this.effectiveTheme() === 'dark');
  readonly label = computed(() => (this.isDark() ? 'Switch to light mode' : 'Switch to dark mode'));

  constructor() {
    effect(() => {
      const theme = this.effectiveTheme();
      const root = this.document.documentElement;
      root.dataset['theme'] = theme;
      root.style.colorScheme = theme;
      this.persistTheme(this.theme());
    });
  }

  toggle(): void {
    this.theme.set(this.isDark() ? 'light' : 'dark');
  }

  setTheme(theme: ThemePreference): void {
    this.setPreference(theme);
  }

  setPreference(theme: ThemePreference): void {
    this.theme.set(theme);
  }

  private resolveInitialTheme(): ThemePreference {
    const storedTheme = this.readStoredTheme();
    if (storedTheme) {
      return storedTheme;
    }
    return 'system';
  }

  private systemTheme(): EffectiveTheme {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  private readStoredTheme(): ThemePreference | null {
    try {
      const storedTheme = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
      return storedTheme === 'dark' || storedTheme === 'light' || storedTheme === 'system' ? storedTheme : null;
    } catch {
      return null;
    }
  }

  private persistTheme(theme: ThemePreference): void {
    try {
      globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage can be unavailable in private browsing or tests; the live signal still works.
    }
  }
}
