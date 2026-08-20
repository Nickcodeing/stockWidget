@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "ELECTRON=%~dp0node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo 未找到 Electron，请先在本目录执行 npm install。
  pause
  exit /b 1
)

start "" "%ELECTRON%" "%~dp0"
