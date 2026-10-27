"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  trustedPermissionFrame,
  hasMacMediaConsent,
  requestMacMediaConsent,
} = require("../src/permissions.cjs");

test("media checks cannot skip macOS consent before camera access is granted", async () => {
  const asked = [];
  const system = {
    getMediaAccessStatus: () => "not-determined",
    askForMediaAccess: async (type) => {
      asked.push(type);
      return true;
    },
  };
  assert.equal(hasMacMediaConsent(system, { mediaType: "video" }), false);
  assert.equal(hasMacMediaConsent(system, { mediaType: "unknown" }), false);
  assert.equal(
    await requestMacMediaConsent(system, { mediaTypes: ["video"] }),
    true,
  );
  assert.deepEqual(asked, ["camera"]);
});
test("camera-only preview never asks for microphone access", async () => {
  const asked = [];
  const system = {
    getMediaAccessStatus: (type) => (type === "camera" ? "granted" : "denied"),
    askForMediaAccess: async (type) => {
      asked.push(type);
      return false;
    },
  };
  assert.equal(hasMacMediaConsent(system, { mediaType: "video" }), true);
  assert.equal(
    await requestMacMediaConsent(system, { mediaTypes: ["video"] }),
    true,
  );
  assert.deepEqual(asked, []);
  assert.equal(
    await requestMacMediaConsent(system, { mediaTypes: ["audio"] }),
    false,
  );
});
test("ambiguous media requests and untrusted frames are denied", async () => {
  const contents = {};
  assert.equal(
    trustedPermissionFrame(contents, contents, "http://127.0.0.1:4000", {
      isMainFrame: true,
      requestingUrl: "http://127.0.0.1:4000/desktop/settings",
    }),
    true,
  );
  assert.equal(
    trustedPermissionFrame(contents, contents, "http://127.0.0.1:4000", {
      isMainFrame: false,
      requestingUrl: "http://127.0.0.1:4000/desktop/settings",
    }),
    false,
  );
  assert.equal(
    trustedPermissionFrame(contents, contents, "http://127.0.0.1:4000", {
      isMainFrame: true,
      requestingUrl: "https://other.example",
    }),
    false,
  );
  assert.equal(
    trustedPermissionFrame(contents, {}, "http://127.0.0.1:4000", {
      isMainFrame: true,
      requestingUrl: "http://127.0.0.1:4000/",
    }),
    false,
  );
  assert.equal(
    await requestMacMediaConsent(
      {
        askForMediaAccess: () => {
          throw new Error("must not request unknown device");
        },
      },
      {},
    ),
    false,
  );
});
