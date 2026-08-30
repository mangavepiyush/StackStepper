'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
console.log('===================================================');
console.log(' Starting StackStepper Portable Unified Distribution');
console.log(' Root Directory:', PROJECT_ROOT);
console.log('===================================================');

const nodeExe   = path.join(PROJECT_ROOT, 'runtime', 'node', 'node.exe');
const mysqlBin  = path.join(PROJECT_ROOT, 'mysql', 'bin', 'mysqld.exe');
const myCnf     = path.join(PROJECT_ROOT, 'mysql-config', 'my.cnf');
const sqlBackend= path.join(PROJECT_ROOT, 'backend', 'index.js');
const cppBackend= path.join(PROJECT_ROOT, 'backend', 'cpp', 'index.js');
const mysqlData = path.join(PROJECT_ROOT, 'mysql-data');
const nodeMods  = path.join(PROJECT_ROOT, 'node_modules');

// Auto-run setup if missing
if (!fs.existsSync(nodeMods) || !fs.existsSync(path.join(mysqlData, 'mysql'))) {
  console.log('[NOTICE] Missing runtime components. Running setup.js...');
  execSync('"' + nodeExe + '" "' + path.join(__dirname, 'setup.js') + '"', { stdio: 'inherit', cwd: PROJECT_ROOT });
}

// Regenerate my.cnf for current root
const fwdRoot = PROJECT_ROOT.replace(/\\/g, '/');
const cnfContent = [
  '[mysqld]',
  'port=3307',
  'datadir=' + fwdRoot + '/mysql-data',
  'plugin-dir=' + fwdRoot + '/mysql/lib/plugin',
  'lc-messages-dir=' + fwdRoot + '/mysql/share',
].join('\n');
fs.writeFileSync(myCnf, cnfContent, 'utf8');

function waitForPort(port, host, maxMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const interval = setInterval(() => {
      const socket = net.createConnection(port, host);
      socket.on('connect', () => { socket.destroy(); clearInterval(interval); resolve(true); });
      socket.on('error', () => { socket.destroy(); if (Date.now() - start > maxMs) { clearInterval(interval); resolve(false); } });
    }, 500);
  });
}

async function run() {
  console.log('1. Launching custom QueryTracer MySQL server on port 3307...');
  const mysqlProc = spawn(mysqlBin, ['--defaults-file=' + myCnf], { stdio: 'ignore', detached: true });
  mysqlProc.unref();

  const mysqlUp = await waitForPort(3307, '127.0.0.1', 25000);
  if (!mysqlUp) { console.error('[ERROR] MySQL server failed on port 3307'); process.exit(1); }
  console.log('[✓] QueryTracer MySQL started on port 3307.');

  console.log('2. Launching SQL Engine Visualizer Gateway on port 18080...');
  const sqlProc = spawn(nodeExe, [sqlBackend], { cwd: PROJECT_ROOT, stdio: 'ignore', detached: true });
  sqlProc.unref();

  const sqlUp = await waitForPort(18080, '127.0.0.1', 15000);
  if (!sqlUp) { console.error('[ERROR] SQL Gateway failed on port 18080'); process.exit(1); }
  console.log('[✓] SQL Engine Gateway started on port 18080.');

  if (fs.existsSync(cppBackend)) {
    console.log('3. Launching C++ Memory Stepper Backend on port 3000...');
    const cppProc = spawn(nodeExe, [cppBackend], { cwd: PROJECT_ROOT, stdio: 'ignore', detached: true });
    cppProc.unref();

    const cppUp = await waitForPort(3000, '127.0.0.1', 15000);
    if (!cppUp) { console.error('[ERROR] C++ Stepper Backend failed on port 3000'); process.exit(1); }
    console.log('[✓] C++ Memory Stepper Backend started on port 3000.');
  }

  console.log('Opening StackStepper Unified Application in web browser...');
  try { execSync('start http://localhost:3000', { shell: true }); } catch(e) {}

  console.log('===================================================');
  console.log(' StackStepper Portable Unified Application is Running!');
  console.log(' - Main Web Shell        : http://localhost:3000');
  console.log('   ├── 🧠 C++ Memory Lab (GDB & ML Stepper)');
  console.log('   └── 🗄️ SQL Engine Lab (MySQL & QueryTracer)');
  console.log(' Run Stop-StackStepper.bat to shut down all services.');
  console.log('===================================================');
}

run();
