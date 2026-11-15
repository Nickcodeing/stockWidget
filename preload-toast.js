const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('toastApi', {
  click: () => ipcRenderer.send('toast-click')
});
