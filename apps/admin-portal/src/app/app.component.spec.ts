import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideErrorModule } from '@sapiovian/error-ui';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from './core/services/auth.service';
import { ThemeService } from './core/services/theme.service';
import { AppComponent } from './app.component';

describe('Admin AppComponent', () => {
  let fixture: ComponentFixture<AppComponent>;
  let authMock: { user: ReturnType<typeof signal<any>>; checking: ReturnType<typeof signal<boolean>>; checkSession: jasmine.Spy };

  beforeEach(async () => {
    authMock = {
      user: signal(null),
      checking: signal(false),
      checkSession: jasmine.createSpy('checkSession').and.returnValue(of(null))
    };

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
        provideHttpClient(), provideHttpClientTesting(),
        provideErrorModule(() => ({ apiBaseUrl: '/api/v1', source: () => 'admin', accessToken: () => null })),
        { provide: AuthService, useValue: authMock },
        { provide: ThemeService, useValue: {} }
      ]
    }).compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
  });

  it('creates the admin shell root without a real session request', () => {
    expect(fixture.componentInstance).toBeTruthy();
    expect(authMock.checkSession).toHaveBeenCalled();
  });
});
