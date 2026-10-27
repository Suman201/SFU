"use strict";
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
};
async function startServer({
  frontendDir,
  backendOrigin,
  websiteOrigin,
  preferredPort = 0,
}) {
  const backend = new URL(backendOrigin);
  const transport = backend.protocol === "https:" ? https : http;
  let origin;
  const server = http.createServer((req, res) => {
    if (!allowed(req)) return fail(res, 403, "Untrusted origin");
    let url;
    try {
      url = new URL(req.url, origin);
    } catch {
      return fail(res, 400, "Invalid URL");
    }
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/socket.io/")
    ) {
      const upstream = transport.request(
        backend,
        {
          path: req.url,
          method: req.method,
          headers: proxyHeaders(req.headers),
        },
        (remote) => {
          const headers = { ...remote.headers };
          // The desktop is a trusted same-origin client; upstream CORS headers must not expose the local proxy.
          delete headers["access-control-allow-origin"];
          delete headers["access-control-allow-credentials"];
          res.writeHead(remote.statusCode || 502, headers);
          pipeline(remote, res, () => {});
        },
      );
      upstream.on("error", () =>
        fail(res, 502, "The classroom server is unavailable."),
      );
      req.on("aborted", () => upstream.destroy());
      pipeline(req, upstream, () => {});
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return fail(res, 405, "Method not allowed");
    let relative;
    try {
      relative = decodeURIComponent(url.pathname);
    } catch {
      return fail(res, 400, "Invalid path");
    }
    const candidate = path.resolve(frontendDir, "." + relative);
    if (
      !candidate.startsWith(path.resolve(frontendDir) + path.sep) &&
      candidate !== path.resolve(frontendDir)
    )
      return fail(res, 403, "Invalid path");
    let file = candidate;
    try {
      if (!fs.statSync(file).isFile())
        file = path.join(frontendDir, "index.html");
    } catch {
      file = path.extname(candidate)
        ? null
        : path.join(frontendDir, "index.html");
    }
    if (!file || !fs.existsSync(file)) return fail(res, 404, "Not found");
    res.setHeader(
      "Content-Type",
      MIME[path.extname(file)] || "application/octet-stream",
    );
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' ws://127.0.0.1:* https:; font-src 'self' data:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'",
    );
    if (req.method === "HEAD") return res.end();
    pipeline(fs.createReadStream(file), res, () => {});
  });
  function allowed(req) {
    return (
      req.headers.host === new URL(origin).host &&
      (!req.headers.origin || req.headers.origin === origin)
    );
  }
  function proxyHeaders(headers) {
    const clean = { ...headers, host: backend.host };
    if (websiteOrigin) clean.origin = websiteOrigin;
    else delete clean.origin;
    delete clean.referer;
    // Never forward local cookies, which contain the desktop's remembered session, upstream.
    delete clean.cookie;
    return clean;
  }
  server.on("upgrade", (req, socket, head) => {
    if (!allowed(req) || !req.url.startsWith("/socket.io/"))
      return socket.destroy();
    const upstream = transport.request(backend, {
      path: req.url,
      method: "GET",
      headers: proxyHeaders(req.headers),
    });
    upstream.on("upgrade", (response, remote, remoteHead) => {
      socket.write(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`,
      );
      for (let i = 0; i < response.rawHeaders.length; i += 2)
        socket.write(
          `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`,
        );
      socket.write("\r\n");
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
      socket.on("error", () => remote.destroy());
      remote.on("error", () => socket.destroy());
      socket.on("close", () => remote.destroy());
      remote.on("close", () => socket.destroy());
    });
    upstream.on("response", () => socket.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  origin = "http://127.0.0.1:" + server.address().port;
  return {
    origin,
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}
function fail(res, status, message) {
  if (!res.headersSent) res.writeHead(status, { "Content-Type": "text/plain" });
  if (!res.writableEnded) res.end(message);
}
module.exports = { startServer };
