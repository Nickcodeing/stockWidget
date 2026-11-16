const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('alertPopApi', {
  getAlerts: () => ipcRenderer.invoke('get-alerts'),
  markAlertRead: (id) => ipcRenderer.invoke('mark-alert-read', id),
  markAllAlertsRead: () => ipcRenderer.invoke('mark-all-alerts-read'),
  onAlertsChanged: (cb) => {
    ipcRenderer.on('alerts-changed', (_, data) => cb(data));
  }
});
