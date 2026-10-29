import { appErrorModule } from './core/services/error-module';
import { errorInterceptor } from '@sapiovian/error-ui';
import {
  provideHttpClient,
  withInterceptors,
  withXhr,
} from '@angular/common/http';
import {
  ApplicationConfig,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { authInterceptor } from './core/services/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    appErrorModule(),
    provideZonelessChangeDetection(),
    provideAnimations(),
    provideHttpClient(
      withXhr(),
      withInterceptors([errorInterceptor, authInterceptor]),
    ),
    provideRouter(
      routes,
      withInMemoryScrolling({
        anchorScrolling: 'enabled',
        scrollPositionRestoration: 'enabled',
      }),
    ),
  ],
};
