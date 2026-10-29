import { inject, Injector } from '@angular/core';
import { provideErrorModule } from '@sapiovian/error-ui';
import { AuthService } from './auth.service';
import type { ClassroomDesktopBridge } from './desktop-bridge';
import { ADMIN_PORTAL_URL, API_BASE_URL } from './app-environment';

export const appErrorModule = () =>
  provideErrorModule(() => {
    const injector = inject(Injector);
    const desktop: ClassroomDesktopBridge | undefined = window.classroomDesktop;
    return {
      apiBaseUrl: API_BASE_URL,
      documentationBaseUrl: ADMIN_PORTAL_URL,
      ...(desktop
        ? { openDocumentation: (url: string) => desktop.openExternal(url) }
        : {}),
      source: () =>
        globalThis.location?.pathname.startsWith('/desktop') ||
        document.title === 'Sapiovian Classroom'
          ? ('desktop' as const)
          : ('web' as const),
      accessToken: () => injector.get(AuthService).accessToken(),
    };
  });
