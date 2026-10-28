"use strict";
const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  dialog,
  shell,
  Notification,
  desktopCapturer,
  systemPreferences,
  Menu,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { startServer } = require("./server.cjs");
const {
  serverOrigin,
  partitionForServer,
  classPath,
  remindersFrom,
  dueReminders,
  websitePath,
  externalUrl,
} = require("./policy.cjs");
const { UpdateController } = require("./updates.cjs");
const {
  trustedPermissionFrame,
  mediaTypes,
  hasMacMediaConsent,
  requestMacMediaConsent,
} = require("./permissions.cjs");
const { resolveUserDataPath } = require("./user-data.cjs");
app.setName("Sapiovian Classroom");
app.setPath("userData", resolveUserDataPath({
  appData: app.getPath("appData"),
  isPackaged: app.isPackaged,
  override: process.env.SFU_DESKTOP_USER_DATA,
}));
const testMedia = !app.isPackaged && process.env.SFU_DESKTOP_TEST_MEDIA === "1";
if (testMedia) {
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
}
let mainWindow,
  localServer,
  config,
  updater,
  setupWindow,
  captureWindow,
  captureSources = [],
  captureResolve;
let activeClass = false,
  quitting = false,
  pendingClass = null,
  rendererReady = false,
  classroomPartition = "persist:classroom",
  reminders = [],
  remindersUpdatedAt = 0,
  reminderTimer;
const fired = new Set();
const approvedPermissions = new Set();
const statePath = path.join(app.getPath("userData"), "classroom.json");
const state = readJSON(statePath, {});
const preferences = { remindersEnabled: state.remindersEnabled !== false };
const nativeOptions = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
};
function persist() {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = statePath + ".tmp";
  fs.writeFileSync(
    temp,
    JSON.stringify(
      { ...state, remindersEnabled: preferences.remindersEnabled },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  fs.renameSync(temp, statePath);
}
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function trusted(event) {
  return (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents &&
    event.senderFrame === mainWindow.webContents.mainFrame &&
    new URL(event.senderFrame.url).origin === localServer?.origin
  );
}
function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error("Untrusted desktop request.");
    return handler(...args);
  });
}
function deliverClass(input) {
  const target = classPath(
    input,
    config?.websiteUrl || "https://classroom.invalid",
  );
  if (!target) return;
  pendingClass = target;
  if ((!mainWindow || mainWindow.isDestroyed()) && localServer) createWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (rendererReady) {
      pendingClass = null;
      mainWindow.webContents.send("desktop:open-class", target);
    }
  }
}
const lock = app.requestSingleInstanceLock();
if (!lock) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((value) => value.startsWith("sfu-classroom:"));
    if (link) deliverClass(link);
    else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    else if (localServer) createWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverClass(url);
  });
  app.on("before-quit", (event) => {
    if (activeClass && !quitting) {
      event.preventDefault();
      confirmExit();
    } else quitting = true;
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    else if (localServer) createWindow();
  });
  app.on("will-quit", () => {
    clearInterval(reminderTimer);
    localServer?.close();
  });
  app
    .whenReady()
    .then(boot)
    .catch(async (error) => {
      await dialog.showMessageBox({
        type: "error",
        title: "Unable to open Classroom",
        message: "Classroom could not start.",
        detail: safeError(error),
      });
      quitting = true;
      app.quit();
    });
}
async function boot() {
  if (!app.isPackaged && process.platform === "darwin")
    app.dock.setIcon(path.join(__dirname, "../resources/icon.png"));
  app.setAppUserModelId("com.nativesfu.classroom");
  const embedded = readJSON(
    app.isPackaged
      ? path.join(process.resourcesPath, "runtime-config.json")
      : path.join(__dirname, "../assets/runtime-config.json"),
    {},
  );
  const serverValue =
    process.env.SFU_DESKTOP_SERVER_URL || embedded.serverUrl || state.serverUrl;
  const websiteValue =
    process.env.SFU_DESKTOP_WEBSITE_URL ||
    embedded.websiteUrl ||
    state.websiteUrl ||
    serverValue;
  if (serverValue)
    config = {
      serverUrl: serverOrigin(serverValue),
      websiteUrl: serverOrigin(websiteValue),
    };
  else if (!app.isPackaged) config = await setup();
  else
    throw new Error(
      "This classroom installer is missing its institution connection. Contact your institution for the configured installer.",
    );
  const updateUrl = embedded.updateUrl;
  if (updateUrl) {
    const parsed = new URL(updateUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password)
      throw new Error("The update server must use HTTPS.");
    config.updateUrl = parsed.href;
  }
  // Keep credentials and local recovery data scoped to their institution backend.
  classroomPartition = partitionForServer(config.serverUrl);
  state.serverUrl = config.serverUrl;
  state.websiteUrl = config.websiteUrl;
  persist();
  const frontendDir = app.isPackaged
    ? path.join(process.resourcesPath, "frontend")
    : process.env.SFU_DESKTOP_FRONTEND_DIR ||
      path.join(__dirname, "../assets/browser");
  if (!fs.existsSync(path.join(frontendDir, "index.html")))
    throw new Error(
      "The classroom interface is missing. Run the desktop frontend build and prepare:assets before starting.",
    );
  // A stable port keeps the browser origin (and its saved lessons/preferences) stable between app starts.
  localServer = await startServer({
    frontendDir,
    backendOrigin: config.serverUrl,
    websiteOrigin: config.websiteUrl,
    preferredPort: state.port || 0,
  });
  state.port = localServer.port;
  persist();
  configurePermissions();
  configureCapture();
  configureIPC();
  configureUpdates();
  if (app.isPackaged) app.setAsDefaultProtocolClient("sfu-classroom");
  else if (process.defaultApp)
    app.setAsDefaultProtocolClient("sfu-classroom", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? [
            {
              label: app.name,
              submenu: [
                { role: "about" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
              ],
            },
          ]
        : []),
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
          ...(!app.isPackaged ? [{ role: "toggleDevTools" }] : []),
        ],
      },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "close" }] },
    ]),
  );
  createWindow();
  const initialLink = process.argv.find((value) =>
    value.startsWith("sfu-classroom:"),
  );
  if (initialLink) deliverClass(initialLink);
  reminderTimer = setInterval(notifyReminders, 30_000);
  reminderTimer.unref();
}
function createWindow() {
  rendererReady = false;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 640,
    title: "Sapiovian Classroom",
    icon: path.join(__dirname, "../resources/icon.png"),
    backgroundColor: "#f5f7f6",
    show: false,
    webPreferences: {
      ...nativeOptions,
      preload: path.join(__dirname, "preload.cjs"),
      partition: classroomPartition,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("page-title-updated", (event) => event.preventDefault());
  mainWindow.webContents.on(
    "did-start-navigation",
    (_event, _url, sameDocument, mainFrame) => {
      if (mainFrame && !sameDocument) rendererReady = false;
    },
  );
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const checked = websitePath(url, config.websiteUrl);
      shell.openExternal(checked).catch(() => {});
    } catch {}
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== localServer.origin) {
      event.preventDefault();
      try {
        shell.openExternal(websitePath(url, config.websiteUrl)).catch(() => {});
      } catch {}
    }
  });
  mainWindow.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  mainWindow.webContents.on("render-process-gone", () => {
    activeClass = false;
    updater?.setActive(false);
    dialog
      .showMessageBox(mainWindow, {
        type: "warning",
        message: "The classroom window stopped responding.",
        detail:
          "Reload to reconnect. Saved classroom work will be recovered where available.",
        buttons: ["Reload", "Close"],
        defaultId: 0,
      })
      .then(({ response }) =>
        response === 0 ? mainWindow.reload() : mainWindow.close(),
      );
  });
  mainWindow.on("close", (event) => {
    if (activeClass && !quitting) {
      event.preventDefault();
      confirmExit();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.loadURL(localServer.origin + "/desktop");
}
let exitPending = false;
async function confirmExit() {
  if (exitPending) return;
  exitPending = true;
  try {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "Leave classroom?",
      message: "A classroom is still open.",
      detail:
        "Leave or end the class inside the classroom to save your work. Closing the app disconnects you from the class.",
      buttons: ["Stay in classroom", "Close app"],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1) {
      quitting = true;
      app.quit();
    }
  } finally {
    exitPending = false;
  }
}
function configureIPC() {
  handle("desktop:info", () => ({
    version: app.getVersion(),
    platform: process.platform,
    websiteUrl: config.websiteUrl,
    serverUrl: config.serverUrl,
    packaged: app.isPackaged,
  }));
  handle("desktop:preferences", () => ({ ...preferences }));
  handle("desktop:set-preferences", (value) => {
    if (!value || typeof value.remindersEnabled !== "boolean")
      throw new Error("Invalid reminder preference.");
    preferences.remindersEnabled = value.remindersEnabled;
    persist();
    return { ...preferences };
  });
  handle("desktop:class-active", (value) => {
    if (typeof value !== "boolean") throw new Error("Invalid class state.");
    activeClass = value;
    updater.setActive(value);
  });
  handle("desktop:reminders", (items) => {
    reminders = remindersFrom(items, config.websiteUrl);
    remindersUpdatedAt = Date.now();
    notifyReminders();
  });
  handle("desktop:pending-class", () => {
    rendererReady = true;
    const value = pendingClass;
    pendingClass = null;
    return value;
  });
  handle("desktop:website", (value) =>
    shell.openExternal(websitePath(value, config.websiteUrl)),
  );
  handle("desktop:external", (value) => shell.openExternal(externalUrl(value)));
  handle("desktop:check-updates", () => updater.check());
  handle("desktop:install-update", () => updater.install());
  handle("desktop:update-state", () => updater.state);
  handle("desktop:diagnostics", async (value) => {
    if (
      !value ||
      typeof value.description !== "string" ||
      value.description.length > 5000 ||
      typeof value.includeDiagnostics !== "boolean"
    )
      throw new Error("Invalid problem report.");
    const report = {
      description: value.description.trim(),
      createdAt: new Date().toISOString(),
      ...(value.includeDiagnostics
        ? {
            appVersion: app.getVersion(),
            platform: process.platform,
            architecture: process.arch,
            osRelease: os.release(),
            electronVersion: process.versions.electron,
            chromiumVersion: process.versions.chrome,
            serverOrigin: config.serverUrl,
            classroomOpen: activeClass,
            updateStatus: updater.state.status,
          }
        : {}),
    };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Save problem report",
      defaultPath: "classroom-problem-report.json",
      filters: [{ name: "Problem report", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    fs.writeFileSync(result.filePath, JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    return { saved: true, path: result.filePath };
  });
}
function notifyReminders() {
  if (!preferences.remindersEnabled || !Notification.isSupported()) return;
  for (const item of dueReminders(
    reminders,
    fired,
    Date.now(),
    remindersUpdatedAt,
  )) {
    const key = item.id + ":" + item.startsAt;
    fired.add(key);
    if (fired.size > 500) fired.delete(fired.values().next().value);
    const notification = new Notification({
      title: "Class starts soon",
      body:
        item.title +
        " starts in " +
        Math.max(1, Math.ceil((item.startsAt - Date.now()) / 60000)) +
        " minutes.",
      silent: false,
    });
    notification.on("click", () => deliverClass(item.joinPath));
    notification.show();
  }
}
function configurePermissions() {
  const ses = session.fromPartition(classroomPartition);
  const permitted = new Set([
    "media",
    "display-capture",
    "fullscreen",
    "speaker-selection",
  ]);
  ses.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (
      !trustedPermissionFrame(
        contents,
        mainWindow?.webContents,
        localServer.origin,
        details,
        origin,
      ) ||
      !permitted.has(permission)
    )
      return false;
    if (permission !== "media" || testMedia) return true;
    if (process.platform === "darwin")
      return hasMacMediaConsent(systemPreferences, details);
    const types = mediaTypes(details);
    return (
      types.length > 0 && types.every((type) => approvedPermissions.has(type))
    );
  });
  ses.setPermissionRequestHandler(
    async (contents, permission, callback, details) => {
      if (
        !trustedPermissionFrame(
          contents,
          mainWindow?.webContents,
          localServer.origin,
          details,
        ) ||
        !permitted.has(permission)
      )
        return callback(false);
      if (permission !== "media" || testMedia) return callback(true);
      try {
        if (process.platform === "darwin")
          return callback(
            await requestMacMediaConsent(systemPreferences, details),
          );
        const types = mediaTypes(details);
        if (!types.length) return callback(false);
        if (types.every((type) => approvedPermissions.has(type)))
          return callback(true);
        const deviceNames = types
          .map((type) => (type === "video" ? "camera" : "microphone"))
          .join(" and ");
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: "question",
          message: `Allow Classroom to use your ${deviceNames}?`,
          detail: "You control your devices before joining and during class.",
          buttons: ["Allow", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0)
          types.forEach((type) => approvedPermissions.add(type));
        callback(response === 0);
      } catch {
        callback(false);
      }
    },
  );
}
function configureCapture() {
  const ses = session.fromPartition(classroomPartition);
  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (
        request.frame !== mainWindow?.webContents.mainFrame ||
        request.securityOrigin !== localServer.origin ||
        captureWindow
      )
        return callback({});
      try {
        if (
          process.platform === "darwin" &&
          systemPreferences.getMediaAccessStatus("screen") === "denied"
        ) {
          await dialog.showMessageBox(mainWindow, {
            type: "info",
            message: "Allow screen recording in System Settings.",
            detail:
              "Open Privacy & Security → Screen & System Audio Recording, enable Classroom, then restart the app.",
          });
          return callback({});
        }
        captureSources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 320, height: 180 },
        });
        const selected = await new Promise((resolve) => {
          captureResolve = resolve;
          captureWindow = new BrowserWindow({
            parent: mainWindow,
            modal: true,
            width: 790,
            height: 610,
            resizable: true,
            title: "Share lesson content",
            webPreferences: {
              ...nativeOptions,
              preload: path.join(__dirname, "picker-preload.cjs"),
            },
          });
          captureWindow.setMenu(null);
          captureWindow.webContents.setWindowOpenHandler(() => ({
            action: "deny",
          }));
          captureWindow.webContents.on("will-navigate", (event) =>
            event.preventDefault(),
          );
          captureWindow.on("closed", () => {
            captureWindow = null;
            captureResolve?.(null);
            captureResolve = null;
          });
          captureWindow.loadFile(path.join(__dirname, "picker.html"));
        });
        if (!selected) return callback({});
        const source = captureSources.find((item) => item.id === selected.id);
        callback(
          source
            ? {
                video: source,
                ...(selected.audio ? { audio: "loopback" } : {}),
              }
            : {},
        );
      } catch {
        callback({});
      } finally {
        captureSources = [];
      }
    },
    { useSystemPicker: true },
  );
  ipcMain.handle("capture:sources", (event) => {
    if (
      event.sender !== captureWindow?.webContents ||
      event.senderFrame !== captureWindow.webContents.mainFrame
    )
      throw new Error("Untrusted capture request.");
    return captureSources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL(),
    }));
  });
  ipcMain.on("capture:choose", (event, value) => {
    if (
      event.sender !== captureWindow?.webContents ||
      event.senderFrame !== captureWindow.webContents.mainFrame
    )
      return;
    const valid =
      value &&
      typeof value.id === "string" &&
      captureSources.some((source) => source.id === value.id);
    captureResolve?.(
      valid ? { id: value.id, audio: value.audio === true } : null,
    );
    captureResolve = null;
    captureWindow.close();
  });
}
function configureUpdates() {
  const available = app.isPackaged && Boolean(config.updateUrl);
  const nativeUpdater = available
    ? require("electron-updater").autoUpdater
    : null;
  if (available)
    nativeUpdater.setFeedURL({ provider: "generic", url: config.updateUrl });
  updater = new UpdateController({
    updater: nativeUpdater,
    available,
    onState: (value) =>
      mainWindow?.webContents.send("desktop:update-state", value),
    beforeInstall: () => {
      quitting = true;
    },
  });
}
async function setup() {
  return new Promise((resolve) => {
    setupWindow = new BrowserWindow({
      width: 550,
      height: 440,
      resizable: false,
      title: "Connect your classroom",
      webPreferences: {
        ...nativeOptions,
        preload: path.join(__dirname, "setup-preload.cjs"),
      },
    });
    setupWindow.setMenu(null);
    setupWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    setupWindow.webContents.on("will-navigate", (event) =>
      event.preventDefault(),
    );
    setupWindow.on("closed", () => {
      setupWindow = null;
      if (!config) {
        quitting = true;
        app.quit();
      }
    });
    ipcMain.handle("setup:save", (event, value) => {
      if (
        event.sender !== setupWindow?.webContents ||
        event.senderFrame !== setupWindow.webContents.mainFrame
      )
        throw new Error("Untrusted setup request.");
      const selected = {
        serverUrl: serverOrigin(value?.serverUrl),
        websiteUrl: serverOrigin(value?.websiteUrl || value?.serverUrl),
      };
      config = selected;
      ipcMain.removeHandler("setup:save");
      resolve(selected);
      setupWindow.close();
    });
    setupWindow.loadFile(path.join(__dirname, "setup.html"));
  });
}
function safeError(error) {
  if (error?.code === "EADDRINUSE")
    return "The saved classroom port is occupied. Close other Classroom instances and reopen the app.";
  return String(error?.message || "Unknown startup error").slice(0, 500);
}
