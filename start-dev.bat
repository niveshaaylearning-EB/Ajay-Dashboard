@echo off
title NIA Performance Center - Dev Launcher
cd /D "%~dp0"

echo Installing any missing backend packages...
backend\venv\Scripts\pip.exe install -r backend\requirements.txt -q

echo Starting backend (http://localhost:8100) ...
start "Backend (8100)" cmd /k "cd /D "%~dp0backend" && venv\Scripts\python.exe -m uvicorn main:app --host 0.0.0.0 --port 8100 --reload"

echo Starting webportal backend (http://localhost:8101) ...
start "Webportal Backend (8101)" cmd /k "cd /D "%~dp0webportal\backend" && "%~dp0backend\venv\Scripts\python.exe" -m uvicorn main:app --host 0.0.0.0 --port 8101 --reload"

echo Starting frontend (http://localhost:5173) ...
start "Frontend (5173)" cmd /k "cd /D "%~dp0frontend" && npm run dev"

echo.
echo All servers are starting in separate windows.
echo   Backend           : http://localhost:8100
echo   Webportal Backend : http://localhost:8101
echo   Frontend          : http://localhost:5173
echo.

echo Waiting for frontend to come up...
timeout /t 5 /nobreak >nul
start http://localhost:5173

