import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API_BASE_URL } from './app-environment';
import { AuthService, type AuthUser } from './auth.service';
import { CurrencyService } from './currency.service';
import { CurrencySelector } from '../../shared/currency-selector/currency-selector';

describe('currency selection and account persistence', () => {
  let money: CurrencyService;
  let http: HttpTestingController;
  let user: ReturnType<typeof signal<AuthUser | null>>;
  beforeEach(() => {
    localStorage.clear(); localStorage.setItem('native-sfu.currency.guest', 'INR');
    user = signal<AuthUser | null>(null);
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AuthService, useValue: { user } }] });
    money = TestBed.inject(CurrencyService); http = TestBed.inject(HttpTestingController);
    TestBed.tick();
    const now = Date.now(), date = new Date(now).toISOString().slice(0, 10);
    http.expectOne(`${API_BASE_URL}/currencies`).flush({ currencies: ['EUR', 'INR', 'JPY', 'USD'], defaultCurrency: 'EUR', snapshot: {
      base: 'EUR', provider: 'Frankfurter', fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 3600000).toISOString(), rates: { EUR: { rate: '1', date }, INR: { rate: '90', date }, JPY: { rate: '160.5', date }, USD: { rate: '1.1', date } },
    } });
    TestBed.tick();
  });
  afterEach(() => { http.verify(); localStorage.clear(); });
  const account = (id: string): AuthUser => ({ id, name: id, email: `${id}@example.com`, role: 'student', roles: ['student'], permissions: [] });

  it('restores both the saved value and the native selector after its options render', async () => {
    const fixture = TestBed.createComponent(CurrencySelector); fixture.detectChanges(); await fixture.whenStable();
    expect(money.currency()).toBe('INR');
    expect((fixture.nativeElement.querySelector('select') as HTMLSelectElement).value).toBe('INR');
    const label = money.display({ amountMinor: 1500, currency: 'EUR' });
    expect(label).toContain('1,350.00'); expect(label).toContain('€15.00 EUR'); expect(label).toContain('≈');
  });
  it('ignores late preference reads and keeps guest and account choices separate', () => {
    user.set(account('alice')); TestBed.tick();
    const pending = http.expectOne(`${API_BASE_URL}/currencies/preference`);
    money.select('JPY');
    const save = http.expectOne(`${API_BASE_URL}/currencies/preference`);
    expect(save.request.method).toBe('PATCH');
    pending.flush({ currency: 'EUR' }); save.flush({ currency: 'JPY' });
    expect(money.currency()).toBe('JPY');
    expect(localStorage.getItem('native-sfu.currency.alice')).toBe('JPY');
    user.set(account('bob')); TestBed.tick(); http.expectOne(`${API_BASE_URL}/currencies/preference`).flush({ currency: 'KWD' });
    expect(money.currency()).toBe('KWD');
    user.set(null); TestBed.tick(); expect(money.currency()).toBe('INR');
  });
  it('serialises rapid saves and reports account sync failures while retaining the device choice', () => {
    user.set(account('alice')); TestBed.tick(); http.expectOne(`${API_BASE_URL}/currencies/preference`).flush({ currency: null });
    money.select('USD'); money.select('JPY');
    const first = http.expectOne(`${API_BASE_URL}/currencies/preference`); expect(first.request.body).toEqual({ currency: 'USD' });
    first.flush({ currency: 'USD' });
    const last = http.expectOne(`${API_BASE_URL}/currencies/preference`); expect(last.request.body).toEqual({ currency: 'JPY' });
    last.flush({}, { status: 503, statusText: 'Unavailable' });
    expect(money.notice()).toContain('Account sync'); expect(money.currency()).toBe('JPY');
    expect(localStorage.getItem('native-sfu.currency.alice')).toBe('JPY');
    user.set(null); TestBed.tick(); user.set(account('alice')); TestBed.tick();
    const retry = http.expectOne(request => request.url.endsWith('/currencies/preference') && request.method === 'PATCH');
    const read = http.expectOne(request => request.url.endsWith('/currencies/preference') && request.method === 'GET');
    read.flush({ currency: 'EUR' }); expect(money.currency()).toBe('JPY');
    retry.flush({ currency: 'JPY' }); expect(money.currency()).toBe('JPY');
    expect(localStorage.getItem('native-sfu.currency.pending.alice')).toBeNull();
  });
  it('retains unknown legacy currencies and falls back to original prices for unavailable pairs', () => {
    expect(money.batch({ feeAmount: 1200 })).toContain('currency not set');
    expect(money.batch({ feeAmount: 0 })).toBe('Free');
    money.select('CAD'); expect(money.display({ amountMinor: 1500, currency: 'EUR' })).toBe('€15.00 EUR');
  });
});
