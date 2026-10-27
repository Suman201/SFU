"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("classroomSetup", {
  save: (config) => ipcRenderer.invoke("setup:save", config),
});
