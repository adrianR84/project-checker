const fs = require('fs');
const path = require('path');

// Sentry must be loaded before other modules to instrument them
const Sentry = require('@sentry/node');
const { CaptureConsole } = require('@sentry/integrations');
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  // CaptureConsole captures all console.* calls and sends them to Sentry
  integrations: [new CaptureConsole({ levels: ['log', 'info', 'warn', 'error'] })],
});

// Log level thresholds: error=0, warn=1, info=2, log=3
// LOG_LEVEL env var filters output (e.g. LOG_LEVEL=info hides log/debug)
const LEVELS = { error: 0, warn: 1, info: 2, log: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

// FILE_LOG=1 enables appending error-level logs to logs/error.log
const FILE_LOG = process.env.FILE_LOG === '1';

const LOG_DIR = path.join(__dirname, '..', 'logs');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');

// ANSI color codes for console output
const COLORS = {
  error: '\x1b[38;5;203m', // soft red
  warn:  '\x1b[33m', // yellow
  info:  '\x1b[36m', // cyan
  log:   '\x1b[90m', // bright black/gray
};
const RESET = '\x1b[0m';

// Map our levels to Sentry's level names
const SENTRY_LEVEL = { error: 'error', warn: 'warning', info: 'info', log: 'debug' };

// Detects the calling file and line by parsing the Error stack.
// Stack index [4] skips: Error, callerFile(), log(), and the level wrapper (error/warn/info/log).
const callerFile = () => {
  const stack = new Error().stack;
  const match = stack.split('\n')[4]?.match(/\((.*):(\d+):\d+\)/);
  if (!match) return null;
  const filePath = match[1].split('/').pop().split('\\').pop();
  return `${filePath}:${match[2]}`;
};

// Serializes arguments for display: Error objects show .stack, objects become JSON, primitives become strings
const stringifyArg = (a) => {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'object') return JSON.stringify(a);
  return String(a);
};

// Core log handler: filters by level, formats output, optionally writes to file, sends to Sentry
const log = (level, tag, ...args) => {
  // Skip if LOG_LEVEL is more restrictive than this level
  if (LEVELS[level] > MIN_LEVEL) return;

  // Detect whether a tag was provided:
  // - tag is a string AND there are more args → tag is real
  // - otherwise, tag is the first part of the message (no tag)
  const hasTag = typeof tag === 'string' && args.length > 0;
  const rest = hasTag ? args : [tag, ...args];
  const file = callerFile();
  const displayMsg = rest.map(stringifyArg).join(' ');

  const formatted = `[${new Date().toISOString()}] ${COLORS[level]}[${level.toUpperCase()}]${RESET}${hasTag ? ` [${tag}]` : ''}${file ? ` [${file}]` : ''} ${displayMsg}\n`;
  process.stdout.write(formatted);

  // Only append error-level logs to file
  if (FILE_LOG && level === 'error') {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG, formatted);
  }

  // Send to Sentry: use captureException for Error objects, captureMessage for everything else
  const sentryLevel = SENTRY_LEVEL[level];
  const errorObj = rest.find(a => a instanceof Error);
  if (level === 'error' && errorObj) {
    Sentry.captureException(errorObj, { level: sentryLevel });
  } else {
    // Build a synthetic Error with a stack pointing to the actual caller,
    // so captureException can show the correct file/line in Sentry
    const err = new Error(displayMsg);
    err.stack = `Error: ${displayMsg}\n    at ${file} (${file})\n`;
    Sentry.captureException(err, { level: sentryLevel });
  }
};

module.exports = {
  error: (tag, ...a) => log('error', tag, ...a),
  warn:  (tag, ...a) => log('warn', tag, ...a),
  info:  (tag, ...a) => log('info', tag, ...a),
  log:   (tag, ...a) => log('log', tag, ...a),
};

/*
Usage examples:

  const logger = require('./utils/logger');

  // With tag:
  logger.info('server', 'Server started on port 3000');
  logger.warn('auth', 'Invalid token received');
  logger.error('db', 'Connection failed:', new Error('ECONNREFUSED'));

  // Without tag (first arg is the message):
  logger.info('Just a message');
  logger.error(new Error('Something went wrong'));

  // With multiple args:
  logger.log('api', 'Request received:', 'GET', '/users');

  // Env vars:
  //   LOG_LEVEL=error   — show only errors
  //   LOG_LEVEL=warn    — show errors + warnings
  //   LOG_LEVEL=info    — show errors + warnings + info (default)
  //   LOG_LEVEL=log     — show everything including debug
  //   FILE_LOG=1        — append error-level logs to logs/error.log
*/
