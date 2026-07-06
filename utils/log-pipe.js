const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', 'logs');
const logFile = path.join(logDir, 'output.log');

// Ensure logs dir exists and truncate log file
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(logFile, '');

const logStream = fs.createWriteStream(logFile, { flags: 'a' });

process.stdin.pipe(process.stdout);
process.stdin.pipe(logStream);

process.stdin.on('end', () => process.exit(0));
