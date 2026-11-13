@echo off
setlocal
title WhaleGirl Patch Installer
cd /d "%~dp0"

echo.
echo WhaleGirl patch installer
echo   This is a PATCH. WhaleGirl must be installed first:
echo   https://github.com/Banan1cee/whale_girl
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
