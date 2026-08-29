@echo off
setlocal
set ROOT_DIR=%~dp0
set NODE_EXE=%ROOT_DIR%runtime\node\node.exe

if not exist "%NODE_EXE%" (
    where node >nul 2>&1
    if not errorlevel 1 (
        echo Copying system Node.js into portable runtime directory...
        mkdir "%ROOT_DIR%runtime\node" >nul 2>&1
        for /f "delims=" %%i in ('where node') do set SYS_NODE_PATH=%%~dpi
        xcopy /e /i /y "!SYS_NODE_PATH!*" "%ROOT_DIR%runtime\node\" >nul 2>&1
    ) else (
        echo [ERROR] Bundled Node.js runtime missing! Please check runtime\node\ folder.
        exit /b 1
    )
)

"%NODE_EXE%" "%ROOT_DIR%runtime\setup.js"
