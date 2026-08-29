'use strict';
const { execSync } = require('child_process');
console.log('Stopping StackStepper Portable services...');

try {
  execSync('powershell -NoProfile -Command "Stop-Process -Name mysqld -Force -ErrorAction SilentlyContinue"', { stdio: 'ignore' });
} catch(e) {}

try {
  execSync('powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object {$_.Name -eq 'node.exe' -and ($_.CommandLine -like '*backend*index.js*' -or $_.CommandLine -like '*backend*cpp*index.js*')} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', { stdio: 'ignore' });
} catch(e) {}

console.log('All StackStepper Portable services stopped.');
