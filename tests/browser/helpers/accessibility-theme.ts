import type { Page } from '@playwright/test';

/** Settle theme colors while live device meters and media animations keep running. */
export async function setAccessibilityTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate(async value => {
    document.documentElement.dataset['theme'] = value;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    // Snapshot color transitions. Waiting for an entirely idle document never
    // finishes when the live microphone meter starts a width transition each frame.
    const transitions = document.getAnimations().filter(animation => {
      const property = (animation as Animation & { transitionProperty?: string }).transitionProperty;
      return animation.playState === 'running' && property !== undefined && /(?:color$|^fill$|^stroke$)/.test(property);
    });
    await Promise.all(transitions.map(animation => animation.finished.catch(() => undefined)));
  }, theme);
}
