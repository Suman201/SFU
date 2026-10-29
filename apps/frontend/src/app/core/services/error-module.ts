import { inject, Injector } from '@angular/core';
import { provideErrorModule } from '@sapiovian/error-ui';
import { AuthService } from './auth.service';
import { API_BASE_URL } from './app-environment';

export const appErrorModule = () =>
  provideErrorModule(() => {
    const injector = inject(Injector);
    return {
      apiBaseUrl: API_BASE_URL,
      source: () =>
        globalThis.location?.pathname.startsWith('/desktop') ||
        document.title === 'Sapiovian Classroom'
          ? ('desktop' as const)
          : ('web' as const),
      accessToken: () => injector.get(AuthService).accessToken(),
    };
  });
