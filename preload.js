const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  print: {
    checkConnection: () => ipcRenderer.invoke('print:check-connection'),
    printLabel: (labelData) => ipcRenderer.invoke('print:label', labelData),
    printCartonLabel: (data) => ipcRenderer.invoke('print:carton-label', data),
  }
});
