require('dotenv/config');
const Sentry = require('@sentry/node');

const logger = require('./logger');

logger.log('test', 'This is a log message');
logger.info('api', 'Request received:', 'GET', '/users');
logger.info('test', 'This is an info message');
logger.warn('test', 'This is a warning message');
logger.error('test', 'This is an error message');
logger.error('test', 'This is an error with object', { foo: 'bar' });
logger.error('test', 'This is an error with Error', new Error('Something broke'));

// Allow time to flush before exit
setTimeout(() => Sentry.flush(3000).then(() => process.exit(0)), 1000);
