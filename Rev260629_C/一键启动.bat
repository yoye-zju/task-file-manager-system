@echo off
setlocal enabledelayedexpansion
title Quick Start

echo ==================================================
echo   AI Task Lens + File Tag Manager - Quick Start
echo ==================================================
echo.

REM Clean up all old processes first
echo [0/3] Cleaning up old processes...

echo       Checking port 3456 (File Manager)...
for /f "tokens=1-5" %%a in ('netstat -ano ^| findstr "127.0.0.1:3456"') do (
    set "LOCAL=%%b"
    if "!LOCAL!"=="127.0.0.1:3456" (
        taskkill /f /pid %%e >nul 2>&1
        if !errorlevel! equ 0 echo       Killed process on port 3456, PID %%e
    )
)

timeout /t 1 /nobreak >nul

for /f "tokens=5" %%a in ('netstat -ano ^| findstr "127.0.0.1:3456" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
    if !errorlevel! equ 0 echo       Killed zombie on port 3456, PID %%a
)

echo       Checking port 8080 (AI Task Lens)...
for /f "tokens=1-5" %%a in ('netstat -ano ^| findstr "127.0.0.1:8080"') do (
    set "LOCAL=%%b"
    if "!LOCAL!"=="127.0.0.1:8080" (
        taskkill /f /pid %%e >nul 2>&1
        if !errorlevel! equ 0 echo       Killed process on port 8080, PID %%e
    )
)

timeout /t 1 /nobreak >nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "127.0.0.1:8080" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
    if !errorlevel! equ 0 echo       Killed zombie on port 8080, PID %%a
)

echo       Old processes cleaned.
timeout /t 2 /nobreak >nul
echo.

echo [1/3] Starting File Manager Backend (port 3456)...
start "FileManager" "%~dp0_start_file_manager.bat"

REM Wait for service ready (up to 30s)
set READY=
for /l %%i in (1,1,30) do (
    ping 127.0.0.1 -n 1 >nul
    curl.exe -s http://127.0.0.1:3456/api/health >nul 2>&1
    if not errorlevel 1 (
        set READY=1
        goto :FILE_READY
    )
)
:FILE_READY
if defined READY (
    echo       [OK] File Manager is ready (port 3456)
) else (
    echo       [!] WARNING: File Manager may not be ready (port 3456)
    echo       [!] Check the FileManager window for error messages.
)
echo.

echo [2/3] Starting AI Task Lens (port 8080)...
start "TaskLens" "%~dp0_start_task_lens.bat"

set READY=
for /l %%i in (1,1,30) do (
    ping 127.0.0.1 -n 1 >nul
    curl.exe -s http://127.0.0.1:8080/ >nul 2>&1
    if not errorlevel 1 (
        set READY=1
        goto :LENS_READY
    )
)
:LENS_READY
if defined READY (
    echo       [OK] AI Task Lens is ready (port 8080)
) else (
    echo       [!] WARNING: AI Task Lens may not be ready (port 8080)
    echo       [!] Check the TaskLens window for error messages.
)
echo.

echo [3/3] Opening browsers...
start "" "http://localhost:8080"
ping 127.0.0.1 -n 2 >nul
start "" "http://localhost:3456"

echo.
echo ==================================================
echo   All started successfully!
echo ==================================================
echo.
echo   * AI Task Lens:    http://localhost:8080
echo   * File Manager:    http://localhost:3456
echo.
echo   Tip: Close the black windows to stop services.
echo.
ping 127.0.0.1 -n 6 >nul
exit
