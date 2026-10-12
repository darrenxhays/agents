@echo off
rem Double-click to install Prowl on Windows. Runs install.ps1, which installs anything missing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
