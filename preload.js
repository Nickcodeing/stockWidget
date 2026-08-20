const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stockApi', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  reloadConfig: () => ipcRenderer.invoke('reload-config'),
  toggleClickThrough: () => ipcRenderer.invoke('toggle-click-through'),
  setPointerOver: (over) => ipcRenderer.send('pointer-over', over),
  selectTrend: (secId) => ipcRenderer.send('select-trend', secId),
  getStockOrder: (code) => ipcRenderer.invoke('stock-order-info', code),
  reorderStock: (code, action) => ipcRenderer.send('reorder-stock', { code, action }),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  moveWindow: (dx, dy) => ipcRenderer.send('move-window', dx, dy),
  onQuotesUpdate: (cb) => {
    ipcRenderer.on('quotes-update', (_, data) => cb(data));
  },
  onClickThroughChanged: (cb) => {
    ipcRenderer.on('click-through-changed', (_, enabled) => cb(enabled));
  },
  onWidgetReset: (cb) => {
    ipcRenderer.on('widget-reset', () => cb());
  }
});
