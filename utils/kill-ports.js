#!/usr/bin/env node
// Kills processes listening on ports 3000 and 3001.
// Works on Windows, Linux, and macOS.

const { execSync } = require('child_process');

const PORTS = [3000, 3001];

/** Returns true when running on Windows. */
function isWindows() {
  return process.platform === 'win32';
}

/** Returns the PID of the process listening on the given port on Windows, or null. */
function getPortPidWindows(port) {
  try {
    const output = execSync(
      `powershell -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
      { encoding: 'utf8', windowsHide: true }
    );
    const pid = output.trim().split(/\s+/)[0];
    return /^\d+$/.test(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Returns the PID of the process listening on the given port on Unix, or null. */
function getPortPidUnix(port) {
  try {
    const output = execSync(`lsof -ti:${port}`, { encoding: 'utf8' });
    const pid = output.trim().split(/\s+/)[0];
    return /^\d+$/.test(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Platform-aware wrapper returning the PID listening on a port, or null. */
function getPortPid(port) {
  return isWindows() ? getPortPidWindows(port) : getPortPidUnix(port);
}

/** Force-kills a PID on Windows via taskkill; returns true on success. */
function killPidWindows(pid) {
  try {
    execSync(`taskkill /F /PID ${pid}`, { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Force-kills a PID on Unix via kill; returns true on success. */
function killPidUnix(pid) {
  try {
    execSync(`kill -f ${pid}`);
    return true;
  } catch {
    return false;
  }
}

/** Platform-aware wrapper to force-kill a PID; returns true on success. */
function killPid(pid) {
  return isWindows() ? killPidWindows(pid) : killPidUnix(pid);
}

let killed = false;
for (const port of PORTS) {
  const pid = getPortPid(port);
  if (pid) {
    const ok = killPid(pid);
    console.log(ok ? `Killed port ${port} (PID ${pid})` : `Failed to kill port ${port}`);
    killed = true;
  } else {
    console.log(`Port ${port} is free`);
  }
}

if (!killed) {
  console.log('No ports to kill');
}
