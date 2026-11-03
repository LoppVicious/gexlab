@echo off
setlocal
call "%~dp0_config.bat" || exit /b 1
if "%DOMINIO%"=="" (echo Falta el DOMINIO en servidor\servidor.txt & pause & exit /b 1)
echo Empaquetando la app con tu historial (sin el entorno de Windows)...
tar -czf "%TEMP%\gexlab_full.tgz" --exclude=gexlab/.venv --exclude=gexlab/cache --exclude=gexlab/backups --exclude=*/__pycache__ -C "%BASE%" gexlab || (echo Error al empaquetar & pause & exit /b 1)
echo Subiendo al servidor...
%SCP% "%TEMP%\gexlab_full.tgz" ubuntu@%IP%:gexlab_full.tgz || (echo Error al subir & pause & exit /b 1)
echo Instalando (tarda unos minutos la primera vez)...
%SSH% "tar -xzf ~/gexlab_full.tgz -C ~ && rm -f ~/gexlab_full.tgz && bash ~/gexlab/servidor/instalar.sh %DOMINIO% %DUCKDNS_TOKEN%"
del "%TEMP%\gexlab_full.tgz" 2>nul
echo.
echo Siguiente paso: "2 Crear usuario.bat"
pause
