"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const listen = (channel, callback) => {
  if (typeof callback !== "function") return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld(
  "classroomDesktop",
  Object.freeze({
    getInfo: () => ipcRenderer.invoke("desktop:info"),
    getPreferences: () => ipcRenderer.invoke("desktop:preferences"),
    setPreferences: (value) =>
      ipcRenderer.invoke("desktop:set-preferences", value),
    setClassActive: (active) =>
      ipcRenderer.invoke("desktop:class-active", active),
    setReminders: (items) => ipcRenderer.invoke("desktop:reminders", items),
    getPendingClass: () => ipcRenderer.invoke("desktop:pending-class"),
    onOpenClass: (callback) => listen("desktop:open-class", callback),
    openWebsite: (path) => ipcRenderer.invoke("desktop:website", path),
    openExternal: (url) => ipcRenderer.invoke("desktop:external", url),
    checkForUpdates: () => ipcRenderer.invoke("desktop:check-updates"),
    installUpdate: () => ipcRenderer.invoke("desktop:install-update"),
    getUpdateState: () => ipcRenderer.invoke("desktop:update-state"),
    onUpdateState: (callback) => listen("desktop:update-state", callback),
    saveDiagnostics: (value) =>
      ipcRenderer.invoke("desktop:diagnostics", value),
  }),
);
