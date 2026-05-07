@echo off
setlocal

cd /d "%~dp0"

set "BUN_EXE="
where bun >nul 2>&1
if %ERRORLEVEL% equ 0 (
    set "BUN_EXE=bun"
) else if exist "%USERPROFILE%\.bun\bin\bun.exe" (
    set "BUN_EXE=%USERPROFILE%\.bun\bin\bun.exe"
) else if exist "C:\Users\Administrator\.bun\bin\bun.exe" (
    set "BUN_EXE=C:\Users\Administrator\.bun\bin\bun.exe"
) else (
    echo [ERROR] bun not found, please install: https://bun.sh
    pause
    exit /b 1
)

if "%BUN_EXE%"=="bun" goto :server_bun_in_path
for %%I in ("%BUN_EXE%") do set "BUN_DIR=%%~dpI"
set "PATH=%BUN_DIR%;%PATH%"
:server_bun_in_path

if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    "%BUN_EXE%" install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Install failed
        pause
        exit /b 1
    )
)

set SERVER_PORT=3456
if not "%1"=="" set SERVER_PORT=%1

echo ============================================
echo   cc-haha Server
echo ============================================
echo.
echo   URL:  http://127.0.0.1:%SERVER_PORT%
echo   API:  http://127.0.0.1:%SERVER_PORT%/api/providers
echo   WS:   ws://127.0.0.1:%SERVER_PORT%/ws/
echo.

"%BUN_EXE%" ./src/server/index.ts --port %SERVER_PORT%
