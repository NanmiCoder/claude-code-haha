@echo off
setlocal EnableDelayedExpansion

echo ============================================
echo   cc-haha Desktop Build Script
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

if "%BUN_EXE%"=="bun" goto :desktop_build_bun_in_path
for %%I in ("%BUN_EXE%") do set "BUN_DIR=%%~dpI"
set "PATH=%BUN_DIR%;%PATH%"
:desktop_build_bun_in_path

where cargo >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] cargo not found. Install Rust: https://rustup.rs
    pause
    exit /b 1
)

echo Select build type:
echo   1. Frontend only (Vite build, no installer)
echo   2. Full Tauri build (MSI installer)
echo.
set /p MODE="Enter option (1/2): "

if "%MODE%"=="1" goto :frontend
if "%MODE%"=="2" goto :tauri
echo [ERROR] Invalid option
pause
exit /b 1

:frontend
echo.
echo [1/2] Type checking...
"%BUN_EXE%" run lint
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Type check failed
    pause
    exit /b 1
)

echo [2/2] Building frontend...
"%BUN_EXE%" run build
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Frontend build failed
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Frontend build complete!
echo ============================================
echo.
echo   Output: dist\
echo.
goto :end

:tauri
echo.
echo [INFO] Full Tauri build for Windows x64
echo ============================================
echo.
echo This requires:
echo   - Visual Studio 2022 Build Tools (C++ workload)
echo   - Rust toolchain (stable-x86_64-pc-windows-msvc)
echo.
echo The build may take several minutes on first run.
echo.

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

echo Starting Tauri build...
powershell -ExecutionPolicy Bypass -File ".\scripts\build-windows-x64.ps1"
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Tauri build failed
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Tauri build complete!
echo ============================================
echo.
echo   Output: build-artifacts\windows-x64\
echo   Look for the .msi installer there.
echo.

if exist "build-artifacts\windows-x64\BUILD_INFO.txt" (
    echo   Build info:
    for /f "tokens=*" %%l in (build-artifacts\windows-x64\BUILD_INFO.txt) do (
        echo     %%l
    )
)

:end
echo.
pause
