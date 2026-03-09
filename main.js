const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let mainWindow;

function createWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, "dist/index.html"))
  .then(() => {
    console.log("Frontend loaded successfully");
  })
  .catch((err) => {
    console.error("Frontend failed to load:", err);
  });
  mainWindow.webContents.openDevTools();

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`Failed to load: ${errorDescription} (${errorCode})`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ========== Print IPC Handlers ==========
function initPrintHandlers() {
  const barcode = require('./print-server/config/barcode');
  const winston = require('./print-server/config/winston');

  ipcMain.handle('print:check-connection', async () => {
    try {
      const isConnected = await barcode.checkPrinterConnection();
      return {
        success: isConnected,
        msg: isConnected ? 'Printer connected' : 'No printer connected'
      };
    } catch (error) {
      winston.error(`[Check Connection] ${error.message} | Stack: ${error.stack}`);
      return { success: false, msg: error.message };
    }
  });

  ipcMain.handle('print:label', async (event, labelData) => {
    try {
      if (!labelData || !labelData.barcodeLabelCode) {
        return { success: false, msg: 'Invalid label data. barcodeLabelCode is required.' };
      }

      winston.info(`[Print Label] Starting print for item: ${labelData.itemname || 'unknown'}, qty: ${labelData.manufQty || 'N/A'}`);

      const result = await barcode.printLabel(labelData);

      if (!result.success) {
        winston.error(`[Print Label] Failed - printed ${result.printedCount}/${result.requested} | Error: ${result.error}`);
      } else {
        winston.info(`[Print Label] Success - printed ${result.printedCount}/${result.requested}`);
      }

      return {
        success: result.success,
        printedCount: result.printedCount,
        requested: result.requested,
        error: result.error
      };
    } catch (error) {
      winston.error(`[Print Label] ${error.message} | Stack: ${error.stack}`);
      return { success: false, msg: error.message };
    }
  });

  ipcMain.handle('print:carton-label', async (event, data) => {
    try {
      const { printData, prndata } = data;

      if (!printData || !prndata) {
        return { success: false, msg: 'Invalid carton data. printData and prndata are required.' };
      }

      const count = Array.isArray(printData) ? printData.length : 1;
      winston.info(`[Print Carton] Starting print for ${count} carton label(s)`);

      const result = await barcode.printCartonLabel(printData, prndata);

      if (!result.success) {
        winston.error(`[Print Carton] Failed - printed ${result.printedCount}/${result.requested} | Error: ${result.error}`);
      } else {
        winston.info(`[Print Carton] Success - printed ${result.printedCount}/${result.requested}`);
      }

      return {
        success: result.success,
        printedCount: result.printedCount,
        requested: result.requested,
        error: result.error
      };
    } catch (error) {
      winston.error(`[Print Carton] ${error.message} | Stack: ${error.stack}`);
      return { success: false, msg: error.message };
    }
  });

  winston.info('[Print Service] IPC handlers registered successfully');
}

app.whenReady().then(() => {
  // Register print IPC handlers (replaces Express print server)
  initPrintHandlers();

  createWindow();

  // Auto update only when packaged
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
