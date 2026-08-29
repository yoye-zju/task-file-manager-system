@echo off
cd /d "%~dp0..\file-tag-manager"
title File Manager Backend - Port 3456
echo Starting File Manager Backend on port 3456...
echo Working dir: %CD%
echo.

REM Clean up old processes on port 3456
echo [Pre-check] Cleaning up old processes on port 3456...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr "127.0.0.1:3456"') do (
    if not "%%a"=="" (
        taskkill /f /pid %%a >nul 2>&1
        echo       Cleaned up process PID %%a on port 3456
    )
)
timeout /t 1 /nobreak >nul

REM Detect Python path
REM Prefer known install paths, avoid Windows App Store Python stub
set PYTHON_CMD=
if exist "C:\Python312\python.exe" (
    set PYTHON_CMD=C:\Python312\python.exe
) else if exist "C:\Python3\python.exe" (
    set PYTHON_CMD=C:\Python3\python.exe
) else (
    where python >nul 2>&1
    if not errorlevel 1 (
        where python | findstr /V "WindowsApps" >nul 2>&1
        if not errorlevel 1 (
            set PYTHON_CMD=python
        )
    )
)
if "%PYTHON_CMD%"=="" (
    echo [ERROR] Python not found! Please install Python or add it to PATH.
    echo.
    echo ========================================
    echo Press any key to close this window...
    pause >nul
    exit /b 1
)

echo Starting server with: %PYTHON_CMD%
%PYTHON_CMD% server.py
echo.
echo ========================================
echo Server stopped or failed to start.
echo Press any key to close this window...
echo ========================================
pause >nul
