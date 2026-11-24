@echo off
cd /d "%~dp0"
node havuz.mjs
if exist haberler.html start "" haberler.html
pause
