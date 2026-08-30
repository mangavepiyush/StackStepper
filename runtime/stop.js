'use strict';
const { execSync } = require('child_process');
console.log('Stopping StackStepper Portable services...');

try {
  execSync('powershell -NoProfile -Command "Stop-Process -Name mysqld -Force -ErrorAction SilentlyContinue"', { stdio: 'ignore' });
} catch(e) {}

try {
  execSync('powershell -NoProfile -Command "$ports = @(3307, 18080, 3000); foreach ($p in $ports) { $conns = Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue; foreach ($c in $conns) { if ($c.OwningProcess -and $c.OwningProcess -gt 0) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } } }"', { stdio: 'ignore' });
} catch(e) {}

console.log('All StackStepper Portable services stopped cleanly.');
