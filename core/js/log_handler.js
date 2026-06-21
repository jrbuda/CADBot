'use strict';
const winston = require('winston');
const moment  = require('moment');

/**
 * Creates and returns a Winston logger that writes to both the console and a
 * timestamped log file in the configured log folder.
 *
 * @param {string} log_folder - Absolute path to the folder where logs are stored.
 * @returns {import('winston').Logger}
 */
function build_logger(log_folder) {
    return winston.createLogger({
        transports: [
            new winston.transports.Console({
                handleExceptions: true,
                handleRejections: true,
            }),
            new winston.transports.File({
                filename: log_folder + '/cadbot_' + moment().format('YYYY_MM_DD_HH_mm_ss') + '.log',
                handleExceptions: true,
                handleRejections: true,
            }),
        ],
    });
}

module.exports = { build_logger };
