import { createServer, request } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
/** Serves the built admin app and proxies API calls to a real backend. */
export async function startAdminTestServer(backend: string) {
  const root = path.resolve('apps/admin-portal/dist/admin-portal/browser');
  if (!existsSync(path.join(root, 'index.html')))
    throw new Error('Build the admin portal before acceptance.');
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/')) {
      const upstream = request(
        new URL(req.url, backend),
        {
          method: req.method,
          headers: { ...req.headers, host: new URL(backend).host },
        },
        (response) => {
          res.writeHead(response.statusCode || 500, response.headers);
          response.pipe(res);
        },
      );
      upstream.on('error', () => res.writeHead(502).end());
      req.pipe(upstream);
      return;
    }
    let file = path.resolve(
      root,
      '.' +
        decodeURIComponent(new URL(req.url || '/', 'http://local').pathname),
    );
    if (
      !file.startsWith(root + path.sep) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    )
      file = path.join(root, 'index.html');
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
      '.ico': 'image/x-icon',
    };
    res.setHeader(
      'Content-Type',
      types[path.extname(file)] || 'application/octet-stream',
    );
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as any).port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
