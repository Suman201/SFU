import { HttpClient, HttpContext } from '@angular/common/http';
import { Injectable, effect, inject, signal } from '@angular/core';
import { Subject, catchError, concatMap, of, tap } from 'rxjs';
import { DEFAULT_CURRENCY, SUPPORTED_CURRENCIES, formatMoneyWithCode, isCurrencyCode, quoteDisplayMoney, type BatchMoneyFields, type CurrencyCatalogue, type CurrencyCode, type ExchangeRateSnapshot, type Money } from '@native-sfu/contracts';
import { API_BASE_URL } from './app-environment';
import { AuthService } from './auth.service';
import { QUIET_ERROR } from '@sapiovian/error-ui';

@Injectable({ providedIn: 'root' })
export class CurrencyService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly selected = signal<CurrencyCode>(this.read('guest') ?? DEFAULT_CURRENCY);
  private readonly rates = signal<ExchangeRateSnapshot | null>(null);
  private preferenceVersion = 0;
  private readonly saves = new Subject<{ userId: string; currency: CurrencyCode }>();
  readonly currency = this.selected.asReadonly();
  readonly currencies = SUPPORTED_CURRENCIES;
  readonly defaultCurrency = signal<CurrencyCode>(DEFAULT_CURRENCY);
  readonly notice = signal('');

  constructor() {
    this.http.get<CurrencyCatalogue | { data: CurrencyCatalogue }>(`${API_BASE_URL}/currencies`, { context: new HttpContext().set(QUIET_ERROR, true) }).subscribe({
      next: response => {
        const catalogue = this.unwrap(response);
        if (!isCurrencyCode(catalogue.defaultCurrency)) return;
        this.defaultCurrency.set(catalogue.defaultCurrency);
        this.rates.set(catalogue.snapshot);
        if (!this.read(this.auth.user()?.id ?? 'guest') && this.preferenceVersion <= 1) this.selected.set(catalogue.defaultCurrency);
      },
      error: () => { /* Original prices remain visible if reference rates are offline. */ },
    });
    this.saves.pipe(concatMap(job => {
      if (this.auth.user()?.id !== job.userId) return of(null);
      return this.http.patch(`${API_BASE_URL}/currencies/preference`, { currency: job.currency }, { context: new HttpContext().set(QUIET_ERROR, true) }).pipe(tap(() => {
        this.clearPending(job.userId, job.currency);
        if (this.auth.user()?.id === job.userId && this.currency() === job.currency) {
          this.preferenceVersion++;
          this.notice.set('');
        }
      }), catchError(() => {
        if (this.auth.user()?.id === job.userId && this.currency() === job.currency) this.notice.set('Saved on this device. Account sync is unavailable.');
        return of(null);
      }));
    })).subscribe();
    effect(() => {
      const user = this.auth.user();
      const version = ++this.preferenceVersion;
      this.selected.set(this.read(user?.id ?? 'guest') ?? this.defaultCurrency());
      this.notice.set('');
      if (!user) return;
      const pending = this.readPending(user.id);
      if (pending) this.saves.next({ userId: user.id, currency: pending });
      this.http.get<{ currency: CurrencyCode | null } | { data: { currency: CurrencyCode | null } }>(`${API_BASE_URL}/currencies/preference`, { context: new HttpContext().set(QUIET_ERROR, true) }).subscribe({
        next: response => {
          const value = this.unwrap(response).currency;
          if (version !== this.preferenceVersion || this.auth.user()?.id !== user.id || this.readPending(user.id) !== null || !isCurrencyCode(value)) return;
          this.selected.set(value);
          this.write(user.id, value);
        },
        error: () => { /* Device preference survives transient account read failures. */ },
      });
    });
  }
  select(value: string): void {
    if (!isCurrencyCode(value)) return;
    this.preferenceVersion++;
    this.selected.set(value);
    this.notice.set('');
    const userId = this.auth.user()?.id;
    this.write(userId ?? 'guest', value);
    if (userId) {
      try { localStorage.setItem(`native-sfu.currency.pending.${userId}`, value); } catch { /* Device storage can be disabled. */ }
      this.saves.next({ userId, currency: value });
    }
  }
  /** Converted values are explicitly indicative; original price is always retained. */
  display(value: Money): string {
    const original = formatMoneyWithCode(value);
    if (value.currency === this.currency()) return original;
    const snapshot = this.rates();
    if (!snapshot) return original;
    try {
      const quote = quoteDisplayMoney(value, this.currency(), snapshot);
      return `≈ ${formatMoneyWithCode(quote.converted)} (${original})`;
    } catch { return original; }
  }
  batch(value: BatchMoneyFields & { feeAmount?: number | null }): string {
    if (isCurrencyCode(value.feeCurrency) && value.feeMinor !== undefined) {
      if (value.feeMinor === 0) return 'Free';
      return this.display({ amountMinor: value.feeMinor, currency: value.feeCurrency });
    }
    const amount = value.feeAmount;
    if (amount === 0 || amount === undefined || amount === null) return 'Free';
    if (!Number.isFinite(amount) || amount < 0) return 'Price unavailable';
    return `Fee ${amount.toLocaleString(undefined, { maximumFractionDigits: 3 })} · currency not set`;
  }
  private unwrap<T>(value: T | { data: T }): T { return value && typeof value === 'object' && 'data' in value ? (value as { data: T }).data : value as T; }
  private readPending(userId: string): CurrencyCode | null {
    try { const value = localStorage.getItem(`native-sfu.currency.pending.${userId}`); return isCurrencyCode(value) ? value : null; } catch { return null; }
  }
  private clearPending(userId: string, currency: CurrencyCode): void {
    try { if (this.readPending(userId) === currency) localStorage.removeItem(`native-sfu.currency.pending.${userId}`); } catch { /* Best-effort persistence. */ }
  }
  private read(userId: string): CurrencyCode | null {
    try { const value = localStorage.getItem(`native-sfu.currency.${userId}`); return isCurrencyCode(value) ? value : null; } catch { return null; }
  }
  private write(userId: string, value: CurrencyCode): void {
    try { localStorage.setItem(`native-sfu.currency.${userId}`, value); } catch { /* In-memory choice still works. */ }
  }
}
