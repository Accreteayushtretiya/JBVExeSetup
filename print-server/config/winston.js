var winston = require('winston');
var moment = require('moment');
require('winston-daily-rotate-file');

var createdDate = moment().format('YYYY_MM_DD');

var options = {
  file: {
    level: 'info',
    filename: `c://FMS_Production_Logs/logs/print_${createdDate}.log`,
    handleExceptions: true,
    json: true,
    maxsize: 5242880, // 5MB
    maxFiles: '14d',
    colorize: false,
  },
  errorFile: {
    level: 'warn',
    filename: `c://FMS_Production_Logs/logs/print_error_${createdDate}.log`,
    handleExceptions: true,
    json: true,
    maxsize: 5242880, // 5MB
    maxFiles: '14d',
    colorize: false,
  }
};

var logger = winston.createLogger({
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => {
      return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    })
  ),
  transports: [
    new winston.transports.File(options.file),
    new winston.transports.File(options.errorFile),
  ],
  exitOnError: false,
});

logger.stream = {
  write: function (message, encoding) {
    logger.info(`[${moment().format('YYYY-MM-DD H:m:s')}] ${message}`);
  },
};

module.exports = logger;
