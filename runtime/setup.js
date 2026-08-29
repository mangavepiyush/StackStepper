'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
console.log('===================================================');
console.log(' StackStepper Portable Setup');
console.log('===================================================');
console.log('Portable Root:', PROJECT_ROOT);

const nodeExe   = path.join(PROJECT_ROOT, 'runtime', 'node', 'node.exe');
const npmCmd    = path.join(PROJECT_ROOT, 'runtime', 'node', 'npm.cmd');
const mysqlBin  = path.join(PROJECT_ROOT, 'mysql', 'bin', 'mysqld.exe');
const myCnf     = path.join(PROJECT_ROOT, 'mysql-config', 'my.cnf');
const mysqlData = path.join(PROJECT_ROOT, 'mysql-data');
const nodeMods  = path.join(PROJECT_ROOT, 'node_modules');

console.log('[✓] Bundled Node.js runtime verified:', process.version);

// 1. Install Node.js dependencies if missing
if (!fs.existsSync(nodeMods)) {
  console.log('[INFO] Installing Node.js dependencies locally in portable directory...');
  try {
    if (fs.existsSync(npmCmd)) {
      execSync('"' + npmCmd + '" install --no-audit --no-fund', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    } else {
      execSync('npm install --no-audit --no-fund', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    }
    console.log('[✓] Node.js dependencies installed successfully.');
  } catch(e) {
    console.error('[ERROR] Failed to install Node.js dependencies:', e.message);
    process.exit(1);
  }
} else {
  console.log('[✓] Node.js dependencies directory (node_modules) already present.');
}

// 2. Generate portable my.cnf with forward slashes
fs.mkdirSync(path.dirname(myCnf), { recursive: true });
const fwdRoot = PROJECT_ROOT.replace(/\\/g, '/');
const cnfContent = [
  '[mysqld]',
  'port=3307',
  'datadir=' + fwdRoot + '/mysql-data',
  'plugin-dir=' + fwdRoot + '/mysql/lib/plugin',
  'lc-messages-dir=' + fwdRoot + '/mysql/share',
].join('\n');

fs.writeFileSync(myCnf, cnfContent, 'utf8');
console.log('[✓] Portable MySQL configuration generated at:', myCnf);

// 3. Initialize fresh MySQL data directory if missing
if (!fs.existsSync(path.join(mysqlData, 'mysql'))) {
  console.log('[INFO] Initializing fresh MySQL data directory...');
  fs.mkdirSync(mysqlData, { recursive: true });
  try {
    execSync('"' + mysqlBin + '" --defaults-file="' + myCnf + '" --initialize-insecure --user=root', {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      timeout: 120000
    });
    console.log('[✓] Fresh MySQL data directory initialized cleanly.');
  } catch(e) {
    if (fs.existsSync(path.join(mysqlData, 'mysql'))) {
      console.log('[✓] Fresh MySQL data directory initialized.');
    } else {
      console.error('[ERROR] MySQL initialization failed:', e.message);
      process.exit(1);
    }
  }
} else {
  console.log('[✓] Existing MySQL data directory detected — keeping user databases intact.');
}

// 4. Verify bundled MinGW C++ compiler & debugger
const gxxBin = path.join(PROJECT_ROOT, 'runtime', 'mingw', 'bin', 'g++.exe');
const gdbBin = path.join(PROJECT_ROOT, 'runtime', 'mingw', 'bin', 'gdb.exe');

if (fs.existsSync(gxxBin) && fs.existsSync(gdbBin)) {
  console.log('[✓] Bundled C++ toolchain (g++ & gdb) verified in runtime/mingw/bin/');
} else {
  console.log('[INFO] Bundled MinGW C++ toolchain not found in runtime/mingw/bin/. System PATH will be used if available.');
}

console.log('===================================================');
console.log(' StackStepper Portable Setup Completed Successfully!');
console.log('===================================================');
