import { bootstrapApplication } from '@angular/platform-browser';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { provideRouter, Routes } from '@angular/router';
import { AppComponent } from './app/app.component';
import { authInterceptor } from './app/core/services/auth.interceptor';
import { authGuard } from './app/core/services/auth.guards';

document.title = 'EDCONNECTION Classroom';
try { sessionStorage.setItem('native-sfu.desktop', '1'); } catch { /* Restricted storage. */ }
const routes: Routes = [
  { path: 'desktop', loadChildren: () => import('./app/features/desktop/desktop.routes').then((module) => module.DESKTOP_CHILD_ROUTES) },
  { path: 'class-session', canActivate: [authGuard], loadChildren: () => import('./app/features/class-session/class-session.routes').then((module) => module.CLASS_SESSION_ROUTES) },
  { path: '', pathMatch: 'full', redirectTo: 'desktop' },
  { path: '**', redirectTo: 'desktop' }
];
bootstrapApplication(AppComponent, { providers: [provideZonelessChangeDetection(), provideAnimations(), provideHttpClient(withXhr(), withInterceptors([authInterceptor])), provideRouter(routes)] }).catch((error) => console.error(error));
