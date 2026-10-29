import { errorFrames, errorPath } from '@native-sfu/contracts';
/** A minimal fallback when Angular itself cannot start. Uses text nodes, never error HTML. */
export function showBootstrapError(error: unknown): void {
  const reference =
    globalThis.crypto?.randomUUID?.() ?? `startup-${Date.now()}`;
  const details = JSON.stringify(
    {
      product: 'Sapiovian',
      code: 'CLIENT_ERROR',
      reference,
      path: errorPath(globalThis.location?.pathname),
      occurredAt: new Date().toISOString(),
      frames: errorFrames(error instanceof Error ? error.stack : undefined),
    },
    null,
    2,
  );
  console.error('[Sapiovian startup error]', {
    reference,
    code: 'CLIENT_ERROR',
  });
  const root = document.querySelector('sfu-root, sfu-admin-root');
  if (!root) return;
  const panel = document.createElement('main');
  panel.setAttribute('role', 'alert');
  panel.style.cssText =
    'max-width:560px;margin:12vh auto;padding:28px;border:1px solid var(--line,#dbe4e0);border-radius:10px;background:var(--panel,#fff);color:var(--text,#17201d);font:14px/1.6 system-ui';
  const title = document.createElement('h1');
  title.textContent = 'This page could not start';
  const message = document.createElement('p');
  message.textContent =
    'Check your connection, then reload when you are ready. If the problem continues, share these details with support.';
  const trace = document.createElement('pre');
  trace.textContent = details;
  trace.style.cssText =
    'white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.7 monospace';
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload page';
  reload.addEventListener('click', () => location.reload());
  panel.append(title, message, trace, reload);
  root.replaceChildren(panel);
}
