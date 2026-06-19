@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
set ELECTRON_NO_ASAR=
.\node_modules\electron\dist\electron.exe .
