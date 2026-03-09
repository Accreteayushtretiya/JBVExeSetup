const { default: baseX } = require('base-x');

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const base62 = baseX(BASE62_ALPHABET);

// packageType: 1=carton, 2=packaging
const FIELD_LENGTHS = {
    packageType: 1,
    itemCode: 8,
    batchCode: 15,
    expiry: 8,
    random: 4,
    parentItem: 8
};

const TOTAL_LENGTH = Object.values(FIELD_LENGTHS).reduce((a, b) => a + b, 0);

function compressData(data) {
    const rawString =
        String(data.packageType).padStart(FIELD_LENGTHS.packageType, '0') +
        String(data.itemCode).padStart(FIELD_LENGTHS.itemCode, '0') +
        String(data.batchCode).padStart(FIELD_LENGTHS.batchCode, '0') +
        String(data.expiry).padStart(FIELD_LENGTHS.expiry, '0') +
        String(data.random).padStart(FIELD_LENGTHS.random, '0') +
        String(data.parentItem).padStart(FIELD_LENGTHS.parentItem, '0');

    const bigIntValue = BigInt(rawString);
    let hex = bigIntValue.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    const buffer = Buffer.from(hex, 'hex');
    return base62.encode(buffer);
}

function decompressData(encoded) {
    const buffer = Buffer.from(base62.decode(encoded));
    const hex = buffer.toString('hex');
    const bigIntValue = BigInt('0x' + hex);
    let decimalString = bigIntValue.toString(10);
    decimalString = decimalString.padStart(TOTAL_LENGTH, '0');

    let index = 0;
    const extract = (length) => {
        const val = decimalString.slice(index, index + length);
        index += length;
        return val;
    };

    return {
        packageType: extract(FIELD_LENGTHS.packageType),
        itemCode: extract(FIELD_LENGTHS.itemCode),
        batchCode: extract(FIELD_LENGTHS.batchCode),
        expiry: extract(FIELD_LENGTHS.expiry),
        random: extract(FIELD_LENGTHS.random),
        parentItem: extract(FIELD_LENGTHS.parentItem)
    };
}

/**
 * Generate barcode for printing (with random) and for DB storage (without random)
 * @param {number} packageType - 1=carton, 2=packaging
 * @param {number} itemCode
 * @param {number} batchCode
 * @param {string} expiry - DDMMYYYY format
 * @param {number} parentItem
 * @returns {{ printBarcode: string, dbBarcode: string }}
 */
function generateBarcode(packageType, itemCode, batchCode, expiry, parentItem) {
    const random = Math.floor(Math.random() * 10000);

    const printBarcode = compressData({ packageType, itemCode, batchCode, expiry, random, parentItem });
    const dbBarcode = compressData({ packageType, itemCode, batchCode, expiry, random: 0, parentItem });

    return { printBarcode, dbBarcode };
}

/**
 * Decompress a scanned barcode and return the DB-lookup version (random zeroed out)
 * @param {string} scannedBarcode - the raw scanned Base62 string (after stripping any printer prefix)
 * @returns {{ decoded: object, dbBarcode: string }}
 */
function parseScannedBarcode(scannedBarcode) {
    const decoded = decompressData(scannedBarcode);

    // Recompress with random=0 to match DB stored value
    const dbBarcode = compressData({
        packageType: decoded.packageType,
        itemCode: decoded.itemCode,
        batchCode: decoded.batchCode,
        expiry: decoded.expiry,
        random: 0,
        parentItem: decoded.parentItem
    });

    return { decoded, dbBarcode };
}

module.exports = {
    compressData,
    decompressData,
    generateBarcode,
    parseScannedBarcode
};
