require('dotenv/config');

const logger = require('./logger');

logger.log('test', 'This is a log message');
logger.log('debug', 'Very detailed trace', { display: true });      
logger.log('api', 'Request:', 'GET', '/users', { verbose: true, display: true });

logger.info('api', 'Request received:', 'GET', '/users');
logger.info('test', 'This is an info message');

logger.warn('test', 'This is a warning message');

logger.error('test', 'This is an error message');
// logger.error('test', 'This is an error with object', { foo: 'bar' });
// logger.error('test', 'This is an error with Error', new Error('Something broke'));

