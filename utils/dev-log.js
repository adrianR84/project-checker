const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', 'logs');
const logFile = path.join(logDir, 'output.log');

// Ensure logs dir exists and truncate log file
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(logFile, '');

// Spawn concurrently
const child = spawn('npx concurrently "node --watch index.js" "live-server --port=3001 --no-browser --proxy=/api:http://localhost:3000/api public"', {
  cwd: path.join(__dirname, '..'),
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stdout);

const logStream = fs.createWriteStream(logFile, { flags: 'a' });
child.stdout.pipe(logStream);
child.stderr.pipe(logStream);

child.on('close', (code) => process.exit(code));
