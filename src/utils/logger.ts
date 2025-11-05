import winston from 'winston';
import { config } from '../config';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    // Handle circular references in meta objects
    const safeMeta = Object.keys(meta).length ? JSON.stringify(meta, (key, value) => {
      if (key === 'req' || key === 'res' || key === 'socket' || key === '_redirectable' || key === '_currentRequest') {
        return '[Circular]';
      }
      // Handle nested circular references
      if (typeof value === 'object' && value !== null) {
        if (value.constructor && value.constructor.name === 'ClientRequest') {
          return '[ClientRequest]';
        }
        if (value.constructor && value.constructor.name === 'IncomingMessage') {
          return '[IncomingMessage]';
        }
        if (value.constructor && value.constructor.name === 'RedirectableRequest') {
          return '[RedirectableRequest]';
        }
      }
      return value;
    }, 2) : '';
    return `${timestamp} [${level}]: ${message} ${safeMeta}`;
  })
);

export const logger = winston.createLogger({
  level: config.app.logLevel,
  format: logFormat,
  defaultMeta: { service: 'xero-bank-balances' },
  transports: [
    new winston.transports.Console({
      format: config.app.nodeEnv === 'development' ? consoleFormat : logFormat,
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
});

// Create logs directory if it doesn't exist
const logsDir = join(process.cwd(), 'logs');
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

