'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wiztri', {
  scan: (root) => ipcRenderer.invoke('scan', root),
  // Kembalikan fungsi unsub.
  onProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('scan-progress', handler);
    return () => ipcRenderer.removeListener('scan-progress', handler);
  },
});
