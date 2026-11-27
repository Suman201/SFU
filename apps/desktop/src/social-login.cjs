"use strict";
const http = require("node:http");
const { randomBytes, createHash } = require("node:crypto");
const { serverOrigin } = require("./policy.cjs");
const PROVIDERS = {
  google: "https://accounts.google.com/o/oauth2/v2/auth",
  apple: "https://appleid.apple.com/auth/authorize",
};

// Only provider consent is opened externally. Tokens never enter a browser URL.
function authorizationUrl(value, provider) {
  if (typeof value !== "string" || value.length > 8192) throw Error("Invalid sign-in provider.");
  const url = new URL(value);
  if (url.origin + url.pathname !== PROVIDERS[provider] || url.username || url.password || url.hash)
    throw Error("Invalid sign-in provider.");
  return url.href;
}

class DesktopSocialLogin {
  constructor({ backendOrigin, openExternal, focus = () => {}, fetchImpl = fetch, timeoutMs = 600000 }) {
    this.backendOrigin = serverOrigin(backendOrigin);
    this.openExternal = openExternal;
    this.focus = focus;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.pending = null;
  }

  start(provider, role) {
    if (!Object.hasOwn(PROVIDERS, provider) || !["student", "teacher"].includes(role))
      return Promise.reject(Error("Choose a student or teacher sign-in provider."));
    if (this.pending) return Promise.reject(Error("A sign-in is already in progress."));
    return new Promise((resolve, reject) => {
      const flow = {
        provider, role, resolve, reject,
        verifier: randomBytes(32).toString("base64url"),
        path: "/oauth/callback/" + randomBytes(32).toString("base64url"),
        abort: new AbortController(),
      };
      this.pending = flow;
      flow.timer = setTimeout(() => this.finish(flow, Error("Sign-in expired. Please try again.")), this.timeoutMs);
      void this.launch(flow).catch(() => this.finish(flow, Error("Sign-in could not start. Please try again.")));
    });
  }

  async launch(flow) {
    const server = flow.server = http.createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      let url;
      try { url = new URL(req.url, flow.origin); } catch { /* Reject malformed callbacks. */ }
      if (this.pending !== flow || !url || req.method !== "GET" || req.headers.host !== new URL(flow.origin).host || url.origin !== flow.origin || url.pathname !== flow.path) {
        res.writeHead(404); res.end("This sign-in callback is not available."); return;
      }
      const ticket = url.searchParams.get("ticket"), error = url.searchParams.get("error");
      if (url.searchParams.size !== 1 || (ticket ? !/^[A-Za-z0-9_-]{43}$/.test(ticket) : !["failed", "cancelled"].includes(error))) {
        res.writeHead(400); res.end("Invalid sign-in callback."); return;
      }
      res.end(ticket ? "Sign-in verified. Return to Sapiovian Classroom. You can close this tab." : "Sign-in was not completed. Return to Sapiovian Classroom to try again.");
      this.finish(flow, error ? Error(error === "cancelled" ? "Sign-in was cancelled. You can try again." : "The provider could not be verified. Please try again.") : null, { ticket, verifier: flow.verifier });
      this.focus();
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1000;
    server.maxConnections = 8;
    server.on("connection", socket => socket.setTimeout(5000, () => socket.destroy()));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    if (this.pending !== flow) { server.close(); return; }
    flow.origin = `http://127.0.0.1:${server.address().port}`;
    const response = await this.fetch(`${this.backendOrigin}/api/v1/auth/social/${flow.provider}/start`, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: flow.role, challenge: createHash("sha256").update(flow.verifier).digest("hex"), desktopRedirectUri: flow.origin + flow.path }),
      signal: AbortSignal.any([flow.abort.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw Error("Sign-in is unavailable.");
    const body = await response.json();
    const url = authorizationUrl(body?.data?.authorizationUrl, flow.provider);
    if (this.pending === flow) await this.openExternal(url);
  }

  finish(flow, error, result) {
    if (this.pending !== flow) return;
    this.pending = null;
    clearTimeout(flow.timer);
    flow.abort.abort();
    flow.server?.close();
    if (error) flow.reject(error); else flow.resolve(result);
  }

  cancel() {
    if (this.pending) this.finish(this.pending, Error("Sign-in was cancelled. You can try again."));
  }
}
module.exports = { DesktopSocialLogin, authorizationUrl };
