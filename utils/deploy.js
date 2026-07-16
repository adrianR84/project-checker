#!/usr/bin/env node
// deploy.js — scp + pm2 restart via Node.js

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SKIP_INSTALL = process.env.SKIP_INSTALL !== '0';
const SKIP_DATA    = process.env.SKIP_DATA    !== '0';
const SKIP_ENV     = process.env.SKIP_ENV     !== '0';

// Load .env from project root
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
}

const HOST        = process.env.DEPLOY_HOST  || 'adi-vps';
const PROJECT_NAME = path.basename(path.join(__dirname, '..'));
const APP_PATH    = `~/work/${PROJECT_NAME}`;
const APP_NAME    = process.env.DEPLOY_PM2   || 'project-checker';
const SERVER_PORT = process.env.PORT         || '3002';

function run(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, opts.args || [], { stdio: 'inherit', shell: true, ...opts });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
  });
}

function ssh(cmd) {
  return run('ssh', { args: [HOST, cmd] });
}

async function main() {
  console.log(`→ Deploying ${PROJECT_NAME} to ${HOST}:${APP_PATH}`);

  // Create remote folder if it doesn't exist
  await ssh(`mkdir -p ${APP_PATH}`);

  // Build tar exclude args
  const excludes = [
    '--exclude=node_modules',
    '--exclude=.git',
    '--exclude=.devlogger',
    '--exclude=logs',
    '--exclude=.DS_Store',
    '--exclude=*.log',
    '--exclude=utils/drop-tables.js',
  ];
  if (SKIP_DATA) excludes.push('--exclude=data');
  if (SKIP_ENV)  excludes.push('--exclude=.env');

  const tarCmd = `tar -C "${path.join(__dirname, '..')}" -cf - ${excludes.join(' ')} . | ssh ${HOST} "cd ${APP_PATH} && tar -xf -"`;

  console.log('→ Uploading to ' + HOST + ':' + APP_PATH);
  await run(tarCmd);

  // Build pm2 start command
  let pm2Cmd = `cd ${APP_PATH} && PORT=${SERVER_PORT} pm2 start index.js --name '${APP_NAME}' --update-env`;
  if (!SKIP_INSTALL) {
    const installCmd = execSync(`ssh ${HOST} "which pnpm > /dev/null 2>&1 && echo pnpm || echo npm"`, { encoding: 'utf8' }).trim();
    pm2Cmd = `cd ${APP_PATH} && ${installCmd} install && ${pm2Cmd}`;
  }

  console.log('→ (Re)starting pm2');
  await ssh(`pm2 stop '${APP_NAME}' 2>/dev/null; fuser -k ${SERVER_PORT}/tcp 2>/dev/null; sleep 1; ${pm2Cmd}`);

  // Wait for pm2 to settle
  await new Promise(r => setTimeout(r, 2000));

  const status = execSync(`ssh ${HOST} "pm2 info '${APP_NAME}'" 2>/dev/null | grep status | head -1 | awk '{print \\$NF}'`, { encoding: 'utf8' }).trim();
  if (status === 'online') {
    console.log('✓ ' + APP_NAME + ' is online');
  } else {
    console.error('✗ ' + APP_NAME + ' status: ' + status);
    process.exit(1);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
