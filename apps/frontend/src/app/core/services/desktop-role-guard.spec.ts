import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, provideRouter } from '@angular/router';
import { Observable, of } from 'rxjs';
import { API_BASE_URL } from './app-environment';
import { AuthService } from './auth.service';
import { roleGuard } from './auth.guards';

describe('Desktop classroom roles', () => {
  let http: HttpTestingController;
  beforeEach(() => {
    sessionStorage.setItem('native-sfu.desktop', '1');
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), {
      provide: AuthService, useValue: { checkSession: () => of({ id: 'teacher-1', role: 'teacher', roles: ['teacher'] }), redirectPathFor: () => '/desktop/upcoming' }
    }] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { http.verify(); sessionStorage.removeItem('native-sfu.desktop'); });
  function run(expectedRole: string) {
    const route = { data: { role: expectedRole }, queryParamMap: { get: () => 'class-1' } } as unknown as ActivatedRouteSnapshot;
    return TestBed.runInInjectionContext(() => roleGuard(route, { url: `/class-session/${expectedRole}?sessionId=class-1` } as RouterStateSnapshot)) as Observable<unknown>;
  }
  it('lets a teacher attend an enrolled class as a student when the backend authorizes it', () => {
    let result: unknown;
    run('student').subscribe((value) => result = value);
    http.expectOne(`${API_BASE_URL}/desktop/classes/class-1`).flush({ data: { role: 'student' } });
    expect(result).toBe(true);
  });
  it('rejects a forged teacher URL for a student membership', () => {
    let result: unknown;
    run('teacher').subscribe((value) => result = value);
    http.expectOne(`${API_BASE_URL}/desktop/classes/class-1`).flush({ role: 'student' });
    expect(TestBed.inject(Router).serializeUrl(result as never)).toBe('/desktop/join?sessionId=class-1');
  });
});
