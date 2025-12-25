// Preload script for Electron
// This runs before your React app loads and has access to Node.js APIs

const { contextBridge } = require('electron');

// Expose any APIs you need to the renderer process here
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // Add more APIs as needed
});
