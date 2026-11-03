@echo off
REM GEX Lab - quita las tareas del recolector (los datos guardados se conservan)
cd /d "%~dp0"
".venv\Scripts\python.exe" recolector.py --desinstalar
echo.
echo Tareas eliminadas. Los datos de la carpeta history se conservan.
pause
