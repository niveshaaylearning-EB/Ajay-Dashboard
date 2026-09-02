@echo off
title NIA Performance Center
cd /D "%~dp0"

echo Installing any missing packages...
backend\venv\Scripts\pip.exe install -r backend\requirements.txt -q

echo Starting NIA Performance Center...
backend\venv\Scripts\python.exe run.py
pause
