import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AccountRecoveryForm } from './account-recovery-form';

describe('Account recovery form', () => {
  let http: HttpTestingController;
  let previousUrl: string;
  beforeEach(() => {
    previousUrl = location.pathname + location.search + location.hash;
    TestBed.configureTestingModule({ imports: [AccountRecoveryForm], providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { http.verify(); history.replaceState(history.state, '', previousUrl); });
  const form = (mode: 'request' | 'reset' = 'request') => {
    const fixture = TestBed.createComponent(AccountRecoveryForm);
    fixture.componentRef.setInput('apiBaseUrl', '/api/v1'); fixture.componentRef.setInput('mode', mode); fixture.detectChanges();
    return fixture;
  };
  const fill = (root: HTMLElement, id: string, value: string) => {
    const input = root.querySelector<HTMLInputElement>('#' + id)!; input.value = value; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('blur'));
  };
  it('shows a generic acknowledgement without account data', () => {
    const fixture = form(); fill(fixture.nativeElement, 'recovery-email', 'learner@example.test'); fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const request = http.expectOne('/api/v1/auth/forgot-password'); expect(request.request.body).toEqual({ email: 'learner@example.test' });
    request.flush(null, { status: 204, statusText: 'No Content' }); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('If an active account matches'); expect(fixture.nativeElement.textContent).not.toContain('registered');
  });
  it('removes the reset token from the URL and requires matching passwords', () => {
    const token = 'a'.repeat(64); history.replaceState(history.state, '', location.pathname + '#token=' + token);
    const fixture = form('reset'); expect(location.hash).toBe(''); expect(document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
    fill(fixture.nativeElement, 'recovery-password', 'NewPassword@123'); fill(fixture.nativeElement, 'recovery-confirm', 'DifferentPassword@123'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button[type="submit"]').disabled).toBeTrue(); expect(fixture.nativeElement.textContent).toContain('Passwords must match');
    fill(fixture.nativeElement, 'recovery-confirm', 'NewPassword@123'); fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const request = http.expectOne('/api/v1/auth/reset-password'); expect(request.request.body).toEqual({ token, password: 'NewPassword@123' });
    request.flush(null, { status: 204, statusText: 'No Content' }); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Your password has been updated'); expect(fixture.nativeElement.querySelector('input')).toBeNull();
    history.replaceState(history.state, '', location.pathname + '#token=' + 'b'.repeat(64));
    window.dispatchEvent(new HashChangeEvent('hashchange')); fixture.detectChanges();
    expect(location.hash).toBe(''); expect(fixture.nativeElement.querySelector('#recovery-password')).not.toBeNull();
    fill(fixture.nativeElement, 'recovery-password', 'AnotherPassword@123'); fill(fixture.nativeElement, 'recovery-confirm', 'AnotherPassword@123'); fixture.detectChanges();
    fixture.nativeElement.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const next = http.expectOne('/api/v1/auth/reset-password'); expect(next.request.body.token).toBe('b'.repeat(64)); next.flush(null, { status: 204, statusText: 'No Content' }); fixture.destroy();
  });
  it('rejects malformed links without submitting a recovery token', () => {
    history.replaceState(history.state, '', location.pathname + '#token=invalid'); const fixture = form('reset');
    expect(location.hash).toBe(''); expect(fixture.nativeElement.textContent).toContain('incomplete or invalid'); http.expectNone('/api/v1/auth/reset-password'); fixture.destroy();
  });
});
