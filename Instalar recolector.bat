@echo off
REM GEX Lab - instala el recolector diario en el Programador de tareas de Windows
cd /d "%~dp0"
title GEX Lab - instalar recolector

set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY (where python >nul 2>nul && set PY=python)
if not exist ".venv" (
  if not defined PY (echo No se encuentra Python 3. & pause & exit /b 1)
  echo Preparando el entorno...
  %PY% -m venv .venv || (echo No se pudo crear el entorno. & pause & exit /b 1)
  ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt
)
".venv\Scripts\python.exe" -c "import numpy, certifi" 2>nul || ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt

".venv\Scripts\python.exe" recolector.py --instalar
echo.
pause
