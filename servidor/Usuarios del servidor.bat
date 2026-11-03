@echo off
setlocal
call "%~dp0_config.bat" || exit /b 1
echo   lista                    ver usuarios
echo   contrasena NOMBRE        cambiar contrasena
echo   desactivar NOMBRE        bloquear el acceso
echo   activar NOMBRE
echo   borrar NOMBRE
set /p "C=Orden: "
if "%C%"=="" exit /b 1
%SSH% -t "cd ~/gexlab && GEX_AUTH=1 .venv/bin/python usuarios.py %C%"
pause
