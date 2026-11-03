@echo off
setlocal
call "%~dp0_config.bat" || exit /b 1
set /p "U=Nombre de usuario (minusculas, sin espacios): "
if "%U%"=="" exit /b 1
echo.
echo 1 = escribir yo la contrasena    2 = que la genere el servidor
set /p "M=Opcion [1/2]: "
if "%M%"=="2" (
  %SSH% -t "cd ~/gexlab && GEX_AUTH=1 .venv/bin/python usuarios.py crear %U% --generar"
) else (
  %SSH% -t "cd ~/gexlab && GEX_AUTH=1 .venv/bin/python usuarios.py crear %U%"
)
pause
