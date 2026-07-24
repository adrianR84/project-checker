const fs = require('fs');
const path = require('path');


// Sentry must be first to instrument modules
const Sentry = require('@sentry/node');
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  enableLogs: true, // enable Sentry Log Stream (free, no quota)
  integrations: [
    Sentry.consoleLoggingIntegration({ levels: ['log', 'warn', 'info', 'error'] }), // error/warn/info/log → Log Stream (free)
  ],
});

// Log level thresholds: error=0, warn=1, info=2, log=3
// LOG_LEVEL env var filters output (e.g. LOG_LEVEL=info hides log/debug)
const LEVELS = { error: 0, warn: 1, info: 2, log: 3 };
const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

// FILE_LOG=1 enables appending error-level logs to logs/error.log
const FILE_LOG = process.env.FILE_LOG === '1';

// LOG_VERBOSE=1 sends full args to Sentry but only tag+message to terminal
const LOG_VERBOSE = process.env.LOG_VERBOSE === '1';

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

// Core log handler: filters by level, formats output, writes to file, calls console.*
const log = (level, tag, ...args) => {
  // Extract { verbose, display } options from last arg — must be a plain object
  const lastArg = args[args.length - 1];
  const opts = (typeof lastArg === 'object' && !Array.isArray(lastArg) && lastArg !== null)
    ? args.pop()
    : {};

  // Skip if LOG_LEVEL is restrictive (unless display: true overrides it)
  if (LEVELS[level] > MIN_LEVEL && !opts.display) return;

  // Detect whether a tag was provided:
  // - tag is a string AND there are more args → tag is real
  // - otherwise, tag is the first part of the message (no tag)
  const hasTag = typeof tag === 'string' && args.length > 0;
  const rest = hasTag ? args : [tag, ...args];
  const file = callerFile();

  // errorMsg: full args joined — used only in captureException for errors
  const errorMsg = rest.map(stringifyArg).join(' ');
  // displayMsg: short unless LOG_VERBOSE=1 or { verbose: true } forces full args
  const displayMsg = (LOG_VERBOSE || opts.verbose)
    ? errorMsg
    : (rest.length > 1 ? `${stringifyArg(rest[0])}` : errorMsg);

  const formatted = `[${new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 19)}] ${COLORS[level]}[${level.toUpperCase()}]${RESET}${hasTag ? ` [${tag}]` : ''}${file ? ` [${file}]` : ''} ${displayMsg}`;

  // Errors → Issues (quota applies) via captureException with synthetic stack for correct file/line
  // Warn/info/log → Log Stream (free) via console.* + consoleLoggingIntegration
  if (level === 'error') {
    console.error(formatted);
    const errorObj = rest.find(a => a instanceof Error);
    if (errorObj) {
      Sentry.captureException(errorObj, { level: 'error' });
    } else {
      const err = new Error(errorMsg);
      err.stack = `Error: ${errorMsg}\n    at ${file} (${file})\n`;
      Sentry.captureException(err, { level: 'error' });
    }
  } else if (level === 'warn') {
    console.warn(formatted);
  } else if (level === 'info') {
    console.info(formatted);
  } else {
    console.log(formatted);
  }

  // Only append error-level logs to file
  if (FILE_LOG && level === 'error') {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG, formatted + '\n');
  }
};

// Flush Sentry before exit so pending events aren't dropped on crash
process.on('exit', () => Sentry.flush(3000));

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
  // Default:     [LOG] [api] [file.js:10] Request received:
  // With { verbose: true }: [LOG] [api] [file.js:10] Request received: GET /users

  // Per-call overrides:
  logger.log('debug', 'Very detailed trace', { display: true });        // show even if LOG_LEVEL=error
  logger.log('api', 'Request:', 'GET', '/users', { verbose: true });    // show full args

  // Env vars:
  //   LOG_LEVEL=error   — show only errors
  //   LOG_LEVEL=warn    — show errors + warnings
  //   LOG_LEVEL=info    — show errors + warnings + info (default)
  //   LOG_LEVEL=log     — show everything including debug
  //   FILE_LOG=1        — append error-level logs to logs/error.log
  //   LOG_VERBOSE=1     — show full args by default (short otherwise)
*/
