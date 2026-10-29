import { appErrorModule } from './core/services/error-module';
import { errorInterceptor } from '@sapiovian/error-ui';
import { ViewportScroller } from '@angular/common';
import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import {
  provideHttpClient,
  withInterceptors,
  withXhr,
} from '@angular/common/http';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { authInterceptor } from './core/services/auth.interceptor';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    appErrorModule(),
    provideZonelessChangeDetection(),
    provideAnimations(),
    provideHttpClient(withXhr(), withInterceptors([errorInterceptor, authInterceptor])),
    provideAppInitializer(() => inject(ViewportScroller).setOffset([0, 96])),
    provideRouter(
      routes,
      withInMemoryScrolling({
        anchorScrolling: 'enabled',
        scrollPositionRestoration: 'enabled',
      }),
    ),
  ],
};
