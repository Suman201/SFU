import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { AuthService } from './core/services/auth.service';
import { ThemeService } from './core/services/theme.service';
import { AppComponent } from './app.component';

describe('Admin AppComponent', () => {
  let fixture: ComponentFixture<AppComponent>;
  let authMock: { checking: ReturnType<typeof signal<boolean>>; checkSession: jasmine.Spy };

  beforeEach(async () => {
    authMock = {
      checking: signal(false),
      checkSession: jasmine.createSpy('checkSession').and.returnValue(of(null))
    };

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideRouter([]),
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
