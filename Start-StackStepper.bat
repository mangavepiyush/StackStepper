@echo off
setlocal
set ROOT_DIR=%~dp0
set NODE_EXE=%ROOT_DIR%runtime\node\node.exe

if not exist "%NODE_EXE%" (
    echo [NOTICE] First-time setup required: Missing Node.js runtime.
    call "%ROOT_DIR%setup.bat"
)

"%NODE_EXE%" "%ROOT_DIR%runtime\start.js"
