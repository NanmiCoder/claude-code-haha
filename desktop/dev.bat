@echo off
setlocal EnableDelayedExpansion

echo ============================================
echo   cc-haha Desktop Dev Launcher
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

if "%BUN_EXE%"=="bun" goto :desktop_dev_bun_in_path
for %%I in ("%BUN_EXE%") do set "BUN_DIR=%%~dpI"
set "PATH=%BUN_DIR%;%PATH%"
:desktop_dev_bun_in_path

if not exist "node_modules" (
    echo [INFO] Installing root dependencies...
    pushd ..
    "%BUN_EXE%" install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Root install failed
        popd
        pause
        exit /b 1
    )
    popd
    echo [INFO] Installing desktop dependencies...
    "%BUN_EXE%" install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Desktop install failed
        pause
        exit /b 1
    )
    echo [INFO] Installing adapter dependencies...
    pushd ..\adapters
    if not exist "node_modules" (
        "%BUN_EXE%" install
        if %ERRORLEVEL% neq 0 (
            echo [ERROR] Adapter install failed
            popd
            pause
            exit /b 1
        )
    )
    popd
    echo.
)

echo Select dev mode:
echo   1. Frontend only (Vite dev server on port 1420)
echo   2. Full Tauri dev (Frontend + Rust backend)
echo.
set /p MODE="Enter option (1/2): "

if "%MODE%"=="1" goto :vite
if "%MODE%"=="2" goto :tauri
echo [ERROR] Invalid option
pause
exit /b 1

:vite
echo.
echo [START] Vite dev server - http://localhost:1420
echo ============================================
echo.
echo NOTE: This mode only starts the frontend.
echo       You need to manually start the backend server:
echo         %BUN_EXE% run ..\src\server\index.ts --port 3456
echo.
"%BUN_EXE%" run dev
goto :end

:tauri
echo.
echo [START] Tauri dev mode (Frontend + Rust backend)
echo ============================================
echo.
echo This will compile the Rust backend on first run.
echo Subsequent starts will be much faster.
echo.

where cargo >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] cargo not found. Install Rust: https://rustup.rs
    pause
    exit /b 1
)

"%BUN_EXE%" run tauri dev
goto :end

:end
pause
