import { inject, Injector } from '@angular/core';
import { provideErrorModule } from '@sapiovian/error-ui';
import { AuthService } from './auth.service';
import { API_BASE_URL } from './app-environment';

export const appErrorModule = () =>
  provideErrorModule(() => {
    const injector = inject(Injector);
    return {
      apiBaseUrl: API_BASE_URL,
      documentationBaseUrl: globalThis.location?.origin,
      source: () => 'admin' as const,
      accessToken: () => injector.get(AuthService).accessToken(),
    };
  });
