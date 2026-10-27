"use strict";
const { URL } = require("node:url");
const { createHash } = require("node:crypto");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
function serverOrigin(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error(
      "Use a server origin without a path, credentials, or query.",
    );
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && LOOPBACK.has(url.hostname))
  )
    throw new Error(
      "The classroom server must use HTTPS. HTTP is allowed only for local development.",
    );
  return url.origin;
}
function classPath(input, websiteUrl) {
  if (typeof input !== "string" || input.length > 2048) return null;
  try {
    const url = new URL(input, websiteUrl || "https://classroom.invalid");
    const native =
      url.protocol === "sfu-classroom:" &&
      ["join", "class"].includes(url.hostname);
    const web =
      ["https:", "http:"].includes(url.protocol) &&
      url.origin === new URL(websiteUrl).origin &&
      /^\/(desktop\/join|class-session\/(teacher|student))\/?$/.test(
        url.pathname,
      );
    if (!native && !web) return null;
    const sessionId = url.searchParams.get("sessionId");
    const batchId = url.searchParams.get("batchId");
    if (
      !sessionId ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) ||
      (batchId && !/^[a-zA-Z0-9_-]{1,128}$/.test(batchId))
    )
      return null;
    const params = new URLSearchParams({ sessionId });
    if (batchId) params.set("batchId", batchId);
    return "/desktop/join?" + params.toString();
  } catch {
    return null;
  }
}
function remindersFrom(value, websiteUrl) {
  if (!Array.isArray(value)) throw new Error("Invalid reminders.");
  return value.slice(0, 100).flatMap((item) => {
    const path = classPath(item?.joinPath, websiteUrl);
    const startsAt = Date.parse(item?.startsAt);
    if (
      !path ||
      !Number.isFinite(startsAt) ||
      typeof item.id !== "string" ||
      item.id.length > 128
    )
      return [];
    return [
      {
        id: item.id,
        title: String(item.title || "Class").slice(0, 160),
        startsAt,
        joinPath: path,
      },
    ];
  });
}
function dueReminders(items, fired, now = Date.now(), updatedAt = now) {
  if (!Number.isFinite(updatedAt) || now - updatedAt > 90_000) return [];
  return items.filter(
    (item) =>
      item.startsAt - now <= 5 * 60_000 &&
      item.startsAt > now &&
      !fired.has(item.id + ":" + item.startsAt),
  );
}
function websitePath(input, origin) {
  if (typeof input !== "string" || input.length > 2048)
    throw new Error("Invalid website path.");
  const url = new URL(input, origin);
  if (url.origin !== new URL(origin).origin || url.username || url.password)
    throw new Error("Only the configured classroom website can be opened.");
  return url.href;
}
function externalUrl(value) {
  if (typeof value !== "string" || value.length > 4096)
    throw new Error("Invalid link.");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && LOOPBACK.has(url.hostname)))
  )
    throw new Error("Only secure website links can be opened.");
  return url.href;
}
function partitionForServer(value) {
  return (
    "persist:classroom-" +
    createHash("sha256").update(serverOrigin(value)).digest("hex").slice(0, 24)
  );
}
module.exports = {
  partitionForServer,
  serverOrigin,
  classPath,
  remindersFrom,
  dueReminders,
  websitePath,
  externalUrl,
};
