"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("capturePicker", {
  sources: () => ipcRenderer.invoke("capture:sources"),
  choose: (id, audio) => ipcRenderer.send("capture:choose", { id, audio }),
  cancel: () => ipcRenderer.send("capture:choose", null),
});
