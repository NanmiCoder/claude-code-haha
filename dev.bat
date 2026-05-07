@echo off
setlocal EnableDelayedExpansion

echo ============================================
echo   cc-haha Dev Launcher
echo ============================================
echo.

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

if "%BUN_EXE%"=="bun" goto :dev_bun_in_path
for %%I in ("%BUN_EXE%") do set "BUN_DIR=%%~dpI"
set "PATH=%BUN_DIR%;%PATH%"
:dev_bun_in_path

if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    "%BUN_EXE%" install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Install failed
        pause
        exit /b 1
    )
    echo.
)

echo Select mode:
echo   1. CLI mode (interactive terminal)
echo   2. Server mode (API + WebSocket server)
echo   3. Server + CLI (two windows)
echo.
set /p MODE="Enter option (1/2/3): "

if "%MODE%"=="1" goto :cli
if "%MODE%"=="2" goto :server
if "%MODE%"=="3" goto :both
echo [ERROR] Invalid option
pause
exit /b 1

:cli
echo.
echo [START] CLI mode - interactive terminal
echo ============================================
set CALLER_DIR=%CD%
if exist .env (
    "%BUN_EXE%" --env-file=.env ./src/entrypoints/cli.tsx %*
) else (
    "%BUN_EXE%" ./src/entrypoints/cli.tsx %*
)
goto :end

:server
echo.
echo [START] Server mode - API + WebSocket server
echo ============================================
set SERVER_PORT=3456
echo Server:  http://127.0.0.1:%SERVER_PORT%
echo API:     http://127.0.0.1:%SERVER_PORT%/api/providers
echo.
"%BUN_EXE%" ./src/server/index.ts --port %SERVER_PORT%
goto :end

:both
echo.
echo [START] Server + CLI dual mode
echo ============================================
set SERVER_PORT=3456
echo Starting server on port %SERVER_PORT%...
start "cc-haha Server" "%BUN_EXE%" ./src/server/index.ts --port %SERVER_PORT%
timeout /t 2 /nobreak >nul
echo Starting CLI...
set CALLER_DIR=%CD%
set CC_HAHA_DESKTOP_SERVER_URL=http://127.0.0.1:%SERVER_PORT%
if exist .env (
    "%BUN_EXE%" --env-file=.env ./src/entrypoints/cli.tsx %*
) else (
    "%BUN_EXE%" ./src/entrypoints/cli.tsx %*
)
goto :end

:end
pause
