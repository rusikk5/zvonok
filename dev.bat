@echo off
SET ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
node_modules\.bin\electron.cmd .
