"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { startServer } = require("../src/server.cjs");
test("bundled origin serves SPA and proxies authenticated APIs without local cookies", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classroom-runtime-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Classroom</h1>");
  fs.writeFileSync(path.join(dir, "main.js"), "window.ready=true");
  const backend = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        path: req.url,
        auth: req.headers.authorization,
        cookie: req.headers.cookie,
        origin: req.headers.origin,
      }),
    );
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const server = await startServer({
    frontendDir: dir,
    backendOrigin: "http://127.0.0.1:" + backend.address().port,
    websiteOrigin: "https://school.example",
  });
  t.after(async () => {
    await server.close();
    await new Promise((resolve) => backend.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const page = await fetch(server.origin + "/desktop/join?sessionId=one");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Classroom/);
  assert.match(
    page.headers.get("content-security-policy"),
    /object-src 'none'/,
  );
  const api = await fetch(server.origin + "/api/v1/classes?status=live", {
    headers: {
      Authorization: "Bearer test-token",
      Cookie: "native-sfu.auth.accessToken=private",
      Origin: server.origin,
    },
  });
  assert.deepEqual(await api.json(), {
    path: "/api/v1/classes?status=live",
    auth: "Bearer test-token",
    origin: "https://school.example",
  });
  assert.equal(
    (
      await fetch(server.origin + "/api/v1/classes", {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(server.origin + "/missing.js")).status, 404);
  assert.equal(
    (await fetch(server.origin + "/desktop", { method: "POST" })).status,
    405,
  );
});
test("websocket upgrade preserves Socket.IO bytes and rejects foreign origins", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "classroom-socket-"));
  fs.writeFileSync(path.join(dir, "index.html"), "ok");
  let remoteSocket;
  const backend = http.createServer();
  backend.on("upgrade", (req, socket, head) => {
    remoteSocket = socket;
    assert.equal(req.url, "/socket.io/?EIO=4&transport=websocket");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    if (head.length) socket.write(head);
    socket.on("data", (bytes) => socket.write(bytes));
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const server = await startServer({
    frontendDir: dir,
    backendOrigin: "http://127.0.0.1:" + backend.address().port,
    websiteOrigin: "https://school.example",
  });
  const client = net.connect(server.port, "127.0.0.1");
  t.after(async () => {
    client.destroy();
    remoteSocket?.destroy();
    await server.close();
    await new Promise((resolve) => backend.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const response = new Promise((resolve, reject) => {
    let data = "";
    client.on("data", (bytes) => {
      data += bytes.toString();
      if (data.includes("ping")) resolve(data);
    });
    client.on("error", reject);
  });
  client.write(
    `GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nOrigin: ${server.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nping`,
  );
  assert.match(await response, /101 Switching Protocols/);
});
