import { DOCUMENT } from "@angular/common";
import {
  DestroyRef,
  Injectable,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";
import type { ProfileThemePreference } from "@native-sfu/contracts";

export type ThemePreference = ProfileThemePreference;
type EffectiveTheme = "light" | "dark";

const THEME_STORAGE_KEY = "native-sfu-theme";

@Injectable({ providedIn: "root" })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  private readonly systemQuery = this.document.defaultView?.matchMedia?.(
    "(prefers-color-scheme: dark)",
  );
  private readonly systemTheme = signal<EffectiveTheme>(
    this.systemQuery?.matches ? "dark" : "light",
  );

  readonly theme = signal<ThemePreference>(this.resolveInitialTheme());
  readonly effectiveTheme = computed<EffectiveTheme>(() => {
    const preference = this.theme();
    return preference === "system" ? this.systemTheme() : preference;
  });
  readonly isDark = computed(() => this.effectiveTheme() === "dark");
  readonly label = computed(() =>
    this.isDark() ? "Switch to light mode" : "Switch to dark mode",
  );

  constructor() {
    if (this.systemQuery) {
      const query = this.systemQuery;
      const onChange = (event: MediaQueryListEvent) =>
        this.systemTheme.set(event.matches ? "dark" : "light");
      query.addEventListener("change", onChange);
      inject(DestroyRef).onDestroy(() =>
        query.removeEventListener("change", onChange),
      );
    }
    effect(() => {
      const theme = this.effectiveTheme();
      const root = this.document.documentElement;
      root.dataset["theme"] = theme;
      this.persistTheme(this.theme());
    });
  }

  toggle(): void {
    this.theme.set(this.isDark() ? "light" : "dark");
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
    return "dark";
  }

  private readStoredTheme(): ThemePreference | null {
    try {
      const storedTheme = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
      return storedTheme === "dark" ||
        storedTheme === "light" ||
        storedTheme === "system"
        ? storedTheme
        : null;
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
