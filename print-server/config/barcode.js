const fs = require('fs');
const path = require('path');
const winston = require('./winston');
const puppeteer = require('puppeteer');
const sharp = require('sharp');
const edge = require('electron-edge-js');
const { app } = require("electron");
const {compressData }=  require("./barcode.utils.js")

// Load TSC printer DLL functions
const dll = app.isPackaged
  ? path.join(process.resourcesPath, "tsclibnet.dll")
  : path.join(__dirname, "tsclibnet.dll");
const type = 'TSCSDK.node_usb';

let gobblerPrinter = null;
let gobblerConnected = false;

try {
  const sdkPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'print-server', 'lib', 'xp-node-sdk')
    : path.join(__dirname, '..', 'lib', 'xp-node-sdk');
  const { PosPrinter } = require(sdkPath);

  gobblerPrinter = new PosPrinter('Pos');
  winston.info('[Gobbler SDK] Initialized successfully');
} catch (error) {
  winston.error('[Gobbler SDK] Failed to initialize:', error.message);
  winston.error('[Gobbler SDK] Stack trace:', error.stack);
}

// ========== Gobbler Printer Connection ==========

function gobblerAutoConnect() {
  if (!gobblerPrinter) {
    return { success: 0, msg: 'Gobbler printer SDK not initialized' };
  }

  if (gobblerConnected) {
    return { success: 1, msg: 'Gobbler printer already connected' };
  }

  try {
    const devices = gobblerPrinter.getDeviceLists(true);
    winston.info('[Gobbler] Available devices:', devices);

    if (!devices || devices.length === 0) {
      return { success: 0, msg: 'No Gobbler USB printers detected' };
    }

    for (const device of devices) {
      const candidates = [
        `USB,${device.portPath}`,
        `USB,${device.mode}`,
      ];
      for (const conn of candidates) {
        try {
          winston.info(`[Gobbler] Trying connection: ${conn}`);
          gobblerPrinter.openPort(conn);
          gobblerConnected = true;
          winston.info(`[Gobbler] Connected successfully: ${device.mode} (${conn})`);
          return { success: 1, msg: `Gobbler connected: ${device.mode} (${conn})` };
        } catch (err) {
          winston.warn(`[Gobbler] Connection failed for ${conn}: ${err.message}`);
        }
      }
    }
    return { success: 0, msg: 'Failed to connect to any Gobbler printer' };
  } catch (error) {
    winston.error('[Gobbler] Auto-connect error:', error.message);
    return { success: 0, msg: 'Gobbler auto-connect error: ' + error.message };
  }
}

function gobblerDisconnect() {
  if (gobblerConnected && gobblerPrinter) {
    try {
      gobblerPrinter.closePort();
      gobblerConnected = false;
      winston.info('[Gobbler] Printer disconnected');
      return { success: 1, msg: 'Gobbler printer disconnected' };
    } catch (error) {
      gobblerConnected = false;
      winston.error('[Gobbler] Disconnect error:', error.message);
      return { success: 0, msg: 'Gobbler disconnect error: ' + error.message };
    }
  }
  return { success: 1, msg: 'Gobbler printer was not connected' };
}

function gobblerReconnect() {
  winston.info('[Gobbler] Reconnecting (stale connection detected)...');
  try { gobblerPrinter.closePort(); } catch (e) { /* ignore close errors */ }
  gobblerConnected = false;
  return gobblerAutoConnect();
}

/**
 * Detect which printer is available
 * @returns {Promise<string>} 'gobbler' | 'tsc' | 'none'
 */
async function getConnectedPrinter() {
  // First check Gobbler
  if (gobblerPrinter) {
    // If marked connected, verify it's still alive by checking device list
    if (gobblerConnected) {
      try {
        const devices = gobblerPrinter.getDeviceLists(true);
        if (!devices || devices.length === 0) {
          winston.warn('[Printer] Gobbler was connected but no devices found, reconnecting...');
          gobblerReconnect();
        }
      } catch (e) {
        winston.warn('[Printer] Gobbler health check failed, reconnecting...');
        gobblerReconnect();
      }
    }

    const gobblerResult = gobblerAutoConnect();
    if (gobblerResult.success === 1) {
      winston.info('[Printer] Using Gobbler printer');
      return 'gobbler';
    }
  }

  // Then check TSC
  try {
    try { await runEdge(closeport, ''); } catch (e) { }
    const result = await runEdge(openport, '');
    if (result == 1) {
      await runEdge(closeport, '');
      winston.info('[Printer] Using TSC printer');
      return 'tsc';
    }
  } catch (e) {
    winston.warn('[Printer] TSC printer not available:', e.message);
  }

  winston.warn('[Printer] No printer connected');
  return 'none';
}

/**
 * Print using Gobbler printer
 */
async function printWithGobbler(tsplCode, bitmapBuffer = null, beforeBitmap = null, afterBitmap = null, hasBitmap = false) {
  if (!gobblerConnected) {
    const connectResult = gobblerAutoConnect();
    if (!connectResult.success) {
      throw new Error(connectResult.msg);
    }
  }

  try {
    gobblerWrite(tsplCode, bitmapBuffer, beforeBitmap, afterBitmap, hasBitmap);
    return true;
  } catch (err) {
    winston.warn('[Gobbler] Write failed, attempting reconnect and retry:', err.message);

    const reconnectResult = gobblerReconnect();
    if (!reconnectResult.success) {
      winston.error('[Gobbler] Reconnect failed:', reconnectResult.msg);
      throw err;
    }

    try {
      gobblerWrite(tsplCode, bitmapBuffer, beforeBitmap, afterBitmap, hasBitmap);
      winston.info('[Gobbler] Retry after reconnect succeeded');
      return true;
    } catch (retryErr) {
      winston.error('[Gobbler] Print error after reconnect:', retryErr.message);
      throw retryErr;
    }
  }
}

function gobblerWrite(tsplCode, bitmapBuffer, beforeBitmap, afterBitmap, hasBitmap) {
  if (hasBitmap && bitmapBuffer) {
    gobblerPrinter.write(Buffer.from(beforeBitmap));
    gobblerPrinter.write(bitmapBuffer);
    gobblerPrinter.write(Buffer.from(afterBitmap + '\nPRINT 1,1\n'));
  } else {
    gobblerPrinter.write(Buffer.from(tsplCode + '\nPRINT 1,1\n'));
  }
}

async function printWithTSC(tsplCode, bitmapBuffer = null, beforeBitmap = null, afterBitmap = null, hasBitmap = false) {
  await runEdge(openport, '');
  await runEdge(clearbuffer, '');

  if (hasBitmap && bitmapBuffer) {
    await runEdge(sendcommand_utf8, beforeBitmap);
    await runEdge(sendcommand_binary, bitmapBuffer);
    await runEdge(sendcommand_utf8, afterBitmap);
  } else {
    await runEdge(sendcommand_utf8, tsplCode);
  }

  await runEdge(printlabel, { quantity: '1', copy: '1' });
  await runEdge(closeport, '');
  return true;
}

let openport, closeport, clearbuffer, sendcommand_utf8, sendcommand_binary, printlabel;

function bindEdgeMethods() {
  try {
    openport = edge.func({ assemblyFile: dll, typeName: type, methodName: 'openport' });
    closeport = edge.func({ assemblyFile: dll, typeName: type, methodName: 'closeport' });
    clearbuffer = edge.func({ assemblyFile: dll, typeName: type, methodName: 'clearbuffer' });
    sendcommand_utf8 = edge.func({ assemblyFile: dll, typeName: type, methodName: 'sendcommand_utf8' });
    sendcommand_binary = edge.func({ assemblyFile: dll, typeName: type, methodName: 'sendcommand_binary' });
    printlabel = edge.func({ assemblyFile: dll, typeName: type, methodName: 'printlabel' });
  } catch (err) {
    winston.error("Failed to bind DLL methods:", err);
    process.exit(1);
  }
}

function runEdge(method, payload) {
  return new Promise((resolve, reject) => {
    method(payload, (err, res) => {
      if (err) reject(err);
      else resolve(res);
    });
  });
}

bindEdgeMethods();

// ========== Print Queue ==========
const printQueue = {
  _queue: [],
  _processing: false,

  add(jobFn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ jobFn, resolve, reject });
      this._processNext();
    });
  },

  async _processNext() {
    if (this._processing || this._queue.length === 0) return;
    this._processing = true;
    const { jobFn, resolve, reject } = this._queue.shift();
    try {
      const result = await jobFn();
      resolve(result);
    } catch (err) {
      reject(err);
    } finally {
      this._processing = false;
      this._processNext();
    }
  }
};

// Helper function to process #variable and #variable+/-number in templates
function processTemplate(template, context) {
  return template.replace(/#([a-zA-Z_][a-zA-Z0-9_]*)([+-]\d+)?/g, (match, varName, op) => {
    let value = context[varName];
    if (typeof value === 'undefined' || value === null) return 'N/A';
    if (op) {
      const num = parseInt(op, 10);
      if (!isNaN(num)) value = Number(value) + num;
    }
    return value;
  });
}

/**
 * Print packaging label(s)
 * @param {Object} itemDetails - Label data received from remote server (includes serialBase)
 */
async function printLabelFn(itemDetails) {
  const {
    ingredients, barcodeNumber, barcodeFields, nutritioninfo, description,
    itemname, batchId, manufDate, expDate, manufQty,
    companyName, companyAddress, companyEmail, companyPhone,
    barcodeLabelCode, isReprint, printLoop, uomName, itemMenuFacturedId
  } = itemDetails;

  winston.info("[Print Server] Label Details:", itemDetails);

  const cleanIngredients = ingredients ? ingredients.replace(/\\"/g, '"').trim() : null;
  const cleanNutritionInfo = nutritioninfo ? nutritioninfo.replace(/\\"/g, '"').trim() : null;
  const cleanDescription = description ? description.replace(/\\"/g, '"').trim() : null;
  const labelWidth = 800; // 100 mm * 8
  const labelHeightMM = 200;
  const labelHeightDots = labelHeightMM * 8; // 1600 dots

  const imageY = 60;
  let htmlSections = [];
  let tableRows = '';

  // Only add ingredients section if data exists
  if (cleanIngredients && cleanIngredients !== 'null' && cleanIngredients !== 'undefined') {
    tableRows += `
      <tr>
        <td class="bordered-td">
          <div class="section">
            ${cleanIngredients}
          </div>
        </td>
      </tr>
      <tr style="height: 12px;"></tr>`;
  }

  // Only add nutrition info section if data exists
  if (cleanNutritionInfo && cleanNutritionInfo !== 'null' && cleanNutritionInfo !== 'undefined') {
    tableRows += `
      <tr>
        <td class="bordered-td">
          ${cleanNutritionInfo}
        </td>
      </tr>
      <tr style="height: 12px;"></tr>`;
  }

  // Only add description section if data exists
  if (cleanDescription && cleanDescription !== 'null' && cleanDescription !== 'undefined') {
    tableRows += `
      <tr>
        <td class="bordered-td">
          <div class="section">
            ${cleanDescription}
          </div>
        </td>
      </tr>
      <tr style="height: 12px;"></tr>`;
  }

  if (tableRows) {
    htmlSections.push(`
      <table style="width: 100%; border: none; border-collapse: collapse;">
        ${tableRows}
      </table>
    `);
  }

  const hasData = htmlSections.length > 0;

  let bitmapBuffer, bytesPerRow, infoHeight, gridY;

  // Only generate bitmap if there's data
  if (hasData) {
    const htmlContent = `
  <html>
    <head>
      <style>
        body {
          font-family: Arial, sans-serif;
          font-size: 16px;
          background-color: white;
          padding: 0;
          margin: 0 !important;
          width: 760px;
        }
          div{
          font-size: 22px;
          box-sizing: border-box;
          }
          p{
            font-size: 20px;
          }
        .section {
          border: none;
          padding: 2px;
          margin-bottom: 12px !important;
          font-size: 20px;
          line-height: 1;
          width: 100%;
          box-sizing: border-box;
        }
          .smallText{
          font-size : 20px !important;
          }
        .bordered-td {
          border: 2px solid black;
          padding: 0;
        }
        .bordered-td > div {
          border: none !important;
          width: 100% !important;
          box-sizing: border-box !important;
          margin: 0 !important;
        }
        .header {
          text-align: center;
          font-weight: bold;
          font-size: 30px;
          margin-bottom: 8px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          border: 1px solid black;
            box-sizing: border-box;
          table-layout: fixed;
        }
        th, td {
          border: 1px solid black;
          padding: 6px 8px;
          font-size: 22px;
          text-align: left;
        }
        th {
          background-color: #f0f0f0;
        }
      </style>
    </head>
    <body>
      ${htmlSections.join('')}
    </body>
  </html>
  `;

    winston.info("[Print Server] Rendering HTML to image...");

    const browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.setContent(htmlContent);
    await page.setViewport({ width: labelWidth, height: 300 });

    const contentSize = await page.evaluate(() => ({
      width: document.body.scrollWidth,
      height: document.body.scrollHeight
    }));

    winston.info(`Content size: ${contentSize.width} x ${contentSize.height}`);

    const imageBuffer = await page.screenshot({
      omitBackground: false,
      clip: {
        x: 0,
        y: 0,
        width: contentSize.width,
        height: contentSize.height
      }
    });
    await browser.close();

    winston.info("[Print Server] Converting to monochrome bitmap...");

    const image = await sharp(imageBuffer)
      .grayscale()
      .flatten({ background: '#FFFFFF' })
      .threshold(200)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const { data, info } = image;
    bytesPerRow = Math.ceil(info.width / 8);
    infoHeight = info.height;
    bitmapBuffer = Buffer.alloc(bytesPerRow * info.height);

    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const pixel = data[y * info.width + x];
        const byteIndex = y * bytesPerRow + Math.floor(x / 8);
        const bitIndex = 7 - (x % 8);
        if (pixel > 0) bitmapBuffer[byteIndex] |= 1 << bitIndex;
      }
    }

    gridY = imageY + info.height + 5;
    if (gridY + 100 > labelHeightDots) {
      winston.warn("[Print Server] Content exceeds label height! Some parts may not print.");
    }
  } else {
    winston.info("[Print Server] No HTML content to render - skipping bitmap generation");
    gridY = 60;
    bytesPerRow = 0;
    infoHeight = 0;
  }

  // Build context for template replacement
  const context = {
    itemname,
    imageY,
    bytesPerRow,
    infoHeight: infoHeight,
    gridY,
    expirydate: expDate || 'N/A',
    manufacturedate: manufDate || 'N/A',
    batchno: batchId || 'N/A',
    netqty: uomName ? `${1} ${uomName}` : 'N/A',
    companyname: companyName || 'N/A',
    companyaddress: companyAddress || 'N/A',
    companyemail: companyEmail || 'N/A',
    companyPhone: companyPhone || 'N/A',
    barcode: batchId || 'N/A',
    imumid: itemMenuFacturedId || 'N/A'
  };

  let printLoopCount = isReprint ? printLoop : Number(manufQty);
  let printedInRun = 0;

  // Detect which printer is connected
  const printerType = await getConnectedPrinter();
  if (printerType === 'none') {
    throw new Error('No printer connected. Please connect a TSC or Gobbler printer.');
  }

  winston.info(`[Print Server] Using ${printerType.toUpperCase()} printer for ${printLoopCount} label(s)...`);
  let printError = null;

  for (let i = 0; i < printLoopCount; i++) {
    // Generate unique barcode with 4-digit random (1000-9999) for each label
    let uniqueBarcode = barcodeNumber || 'N/A';
    if (barcodeFields) {
      const random = Math.floor(1000 + Math.random() * 9000);
      uniqueBarcode = compressData({ ...barcodeFields, random });
    }
    context.barcodeValue = uniqueBarcode;

    const processedCode = processTemplate(barcodeLabelCode, context);
    winston.info(`==== LABEL ${i + 1} TSPL ====\n${processedCode}\n==========================================`);

    let beforeBitmap, afterBitmap;

    if (hasData) {
      const bitmapRegex = /^.*BITMAP.*$/m;
      const match = processedCode.match(bitmapRegex);

      if (!match) {
        throw new Error("BITMAP command not found in TSPL code!");
      }

      const bitmapLine = match[0];
      const bitmapLineIndex = processedCode.indexOf(bitmapLine);

      beforeBitmap = processedCode.substring(0, bitmapLineIndex + bitmapLine.length);
      afterBitmap = processedCode.substring(bitmapLineIndex + bitmapLine.length);
    } else {
      beforeBitmap = processedCode;
      afterBitmap = '';
    }

    try {
      if (printerType === 'gobbler') {
        await printWithGobbler(processedCode, bitmapBuffer, beforeBitmap, afterBitmap, hasData);
      } else {
        await printWithTSC(processedCode, bitmapBuffer, beforeBitmap, afterBitmap, hasData);
      }
      printedInRun++;
      winston.info(`Label ${i + 1}/${printLoopCount} printed successfully.`);
    } catch (err) {
      winston.error(`Error printing label #${i + 1}:`, err);
      printError = err;
      if (printerType === 'tsc') {
        try {
          await runEdge(closeport, '');
        } catch (closeErr) {
          winston.error("Error closing port after failure:", closeErr);
        }
      }
      break;
    }
  }

  // No DB update here - frontend will call remote server's updatePrintCount endpoint

  return {
    success: !printError,
    printedCount: printedInRun,
    requested: printLoopCount,
    error: printError ? printError.message : null
  };
}

/**
 * Print carton label(s)
 * @param {Array} cartonDetailsArray - Carton data from remote server
 * @param {string} prndata - TSPL template
 */
async function printCartonLabelFn(cartonDetailsArray, prndata) {
  const cartonsArray = Array.isArray(cartonDetailsArray) ? cartonDetailsArray : [cartonDetailsArray];

  winston.info(`[Print Server] Printing ${cartonsArray.length} carton label(s)...`);

  // Detect printer
  const printerType = await getConnectedPrinter();
  if (printerType === 'none') {
    throw new Error('No printer connected. Please connect a TSC or Gobbler printer.');
  }

  winston.info(`[Print Server] Using ${printerType.toUpperCase()} printer for ${cartonsArray.length} carton label(s)...`);

  let totalPrintedCount = 0;
  let printError = null;

  for (let index = 0; index < cartonsArray.length; index++) {
    const cartonDetails = cartonsArray[index];
    const {
      cartonId,
      itemname,
      batchId: cartonBatchId,
      uom,
      companyname,
      address,
      companycontactnumber,
      companyemailid,
      scannedQty,
      mfgdate,
      expdate,
      cartonbarcode,
      barcodeFields: cartonBarcodeFields
    } = cartonDetails;

    // Generate unique barcode with 4-digit random (1000-9999) for each carton label
    let uniqueBarcode = cartonbarcode || 'N/A';
    if (cartonBarcodeFields) {
      const random = Math.floor(1000 + Math.random() * 9000);
      uniqueBarcode = compressData({ ...cartonBarcodeFields, random });
    }

    const context = {
      itemname: itemname || 'N/A',
      scannedqty: scannedQty || 'N/A',
      manufacturedate: mfgdate || 'N/A',
      batchno: cartonBatchId || 'N/A',
      expirydate: expdate || 'N/A',
      companyname: companyname || 'N/A',
      address: address || 'N/A',
      companycontactnumber: companycontactnumber || 'N/A',
      companyemailid: companyemailid || 'N/A',
      cartonid: cartonId || 'N/A',
      barcodeValue: uniqueBarcode,
      barcode: uniqueBarcode,
    };

    const processedCode = processTemplate(prndata, context);

    winston.info(`==== CARTON ${index + 1} TSPL ====\n${processedCode}\n======================================================`);

    try {
      if (printerType === 'gobbler') {
        await printWithGobbler(processedCode);
      } else {
        await printWithTSC(processedCode);
      }
      totalPrintedCount++;
      winston.info(`Carton ${index + 1}: Label printed successfully.`);

      // No DB update here - frontend will call remote server's updateCartonPrintCount endpoint
    } catch (err) {
      winston.error(`Error printing carton #${index + 1}:`, err);
      printError = err;
      if (printerType === 'tsc') {
        try { await runEdge(closeport, ''); } catch (e) { }
      }
      break;
    }
  }

  winston.info(`[Print Server] Total: Printed ${totalPrintedCount}/${cartonsArray.length} carton label(s) successfully.`);

  return {
    success: !printError,
    printedCount: totalPrintedCount,
    requested: cartonsArray.length,
    error: printError ? printError.message : null
  };
}

async function checkPrinterConnection() {
  // 1. Check Gobbler
  if (gobblerPrinter) {
    const gobblerResult = gobblerAutoConnect();
    if (gobblerResult.success === 1) {
      winston.info('[Printer Check] Gobbler printer connected.');
      return true;
    }
  }

  // 2. Check TSC
  try {
    try { await runEdge(closeport, ''); } catch (e) { }
    let result = await runEdge(openport, '');
    winston.info(`[Printer Check] Attempt 1 - result: ${result} (Type: ${typeof result})`);

    if (result == 1) {
      await runEdge(closeport, '');
      winston.info("[Printer Check] Printer connection successful (TSC).");
      return true;
    }

    // Attempt 2: Wait a bit and try again
    winston.info("[Printer Check] Failed, retrying...");
    await new Promise(resolve => setTimeout(resolve, 500));
    try { await runEdge(closeport, ''); } catch (e) { }
    result = await runEdge(openport, '');
    winston.info(`[Printer Check] Attempt 2 - result: ${result} (Type: ${typeof result})`);

    if (result == 1) {
      await runEdge(closeport, '');
      winston.info("[Printer Check] Printer connection successful on retry (TSC).");
      return true;
    }

    winston.warn("[Printer Check] Printer connection failed after retries.");
    return false;
  } catch (err) {
    winston.error("[Printer Check] Failed with error:", err);
    return false;
  }
}

module.exports = {
  printLabel: (itemDetails) => printQueue.add(() => printLabelFn(itemDetails)),
  printCartonLabel: (cartonDetailsArray, prndata) => printQueue.add(() => printCartonLabelFn(cartonDetailsArray, prndata)),
  checkPrinterConnection,
  gobblerAutoConnect
};
