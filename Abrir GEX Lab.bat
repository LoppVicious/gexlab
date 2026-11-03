@echo off
REM GEX Lab - lanzador para Windows (doble clic)
cd /d "%~dp0"
title GEX Lab

set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY (where python >nul 2>nul && set PY=python)
if not defined PY (
  echo No se encuentra Python 3. Instalalo desde https://www.python.org/downloads/
  echo Marca la casilla "Add Python to PATH" durante la instalacion.
  pause
  exit /b 1
)

if not exist ".venv" (
  echo Primera ejecucion: preparando el entorno, solo esta vez...
  %PY% -m venv .venv || (echo No se pudo crear el entorno. & pause & exit /b 1)
  ".venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
  ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt || (echo No se pudo instalar numpy. & pause & exit /b 1)
)

".venv\Scripts\python.exe" -c "import numpy, certifi" 2>nul || ".venv\Scripts\python.exe" -m pip install --quiet -r requirements.txt

".venv\Scripts\python.exe" server.py
pause
