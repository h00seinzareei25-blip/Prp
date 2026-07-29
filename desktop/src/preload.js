'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prpNativeStore', {
    isNative: true,
    get: (key) => ipcRenderer.invoke('prp-store:get', String(key)),
    set: (key, value) => ipcRenderer.invoke('prp-store:set', String(key), value),
    keys: () => ipcRenderer.invoke('prp-store:keys'),
    info: () => ipcRenderer.invoke('prp-store:info'),
    backup: () => ipcRenderer.invoke('prp-store:backup')
});
