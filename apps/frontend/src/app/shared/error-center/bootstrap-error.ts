import { errorFrames, errorPath, publicErrorCode } from '@native-sfu/contracts';
/** A minimal fallback when Angular itself cannot start. Uses text nodes, never error HTML. */
export function showBootstrapError(error: unknown): void {
  const reference =
    globalThis.crypto?.randomUUID?.() ?? `startup-${Date.now()}`;
  const reason = 'CLIENT_ERROR';
  const code = publicErrorCode(reason);
  const details = JSON.stringify(
    {
      product: 'Sapiovian',
      code,
      reason,
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
    code,
  });
  const root = document.querySelector('sfu-root, sfu-admin-root');
  if (!root) return;
  const panel = document.createElement('main');
  panel.setAttribute('role', 'alert');
  panel.className = 'sfu-dialog sfu-startup-error';
  const title = document.createElement('h1');
  title.textContent = 'This page could not start';
  const message = document.createElement('p');
  message.textContent =
    'Check your connection, then reload when you are ready. If the problem continues, share these details with support.';
  const identification = document.createElement('p');
  identification.textContent = `Error code ${code} · Reference ${reference}`;
  identification.className = 'sfu-error-feedback';
  const technical = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Technical details';
  const trace = document.createElement('pre');
  trace.textContent = details;
  technical.append(summary, trace);
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload page';
  reload.addEventListener('click', () => location.reload());
  panel.append(title, message, identification, technical, reload);
  root.replaceChildren(panel);
}
