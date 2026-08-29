@echo off
setlocal
set ROOT_DIR=%~dp0
set NODE_EXE=%ROOT_DIR%runtime\node\node.exe

if exist "%NODE_EXE%" (
    "%NODE_EXE%" "%ROOT_DIR%runtime\stop.js"
) else (
    powershell -NoProfile -Command "Stop-Process -Name mysqld -Force -ErrorAction SilentlyContinue"
)
